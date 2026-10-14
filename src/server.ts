import express, { type ErrorRequestHandler } from 'express';
import config from './config.ts';
import { get, migrate, closeDb } from './db.ts';
import * as payments from './payments/index.ts';
import publicRoutes, { cachedPlans, mockPayRouter } from './routes/public.ts';
import { renderHome, robotsTxt, sitemapXml } from './home.ts';
import adminRoutes from './routes/admin.ts';
import * as worker from './worker.ts';

const app = express();
app.set('trust proxy', config.trustProxy);
app.disable('x-powered-by');

// ---------- 安全响应头 ----------
// 页面目前使用内联脚本和样式，所以 script/style 允许 'unsafe-inline'；
// 其余全部收紧：不允许加载外部资源、不允许向外部域名发请求（即使出现 XSS 也难以把数据传出去）、不允许被其他网站嵌入。
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  // 不限制 form-action：手机付款要用表单 POST 提交到易支付，之后还会再跳到支付宝 / 微信（含 alipays:// 等 App 链接），
  // 浏览器对表单提交后的每一次跳转都套用 form-action，无法逐个列全。页面跳转本身 CSP 也拦不住，放开它损失不大
  "frame-ancestors 'none'",
].join('; ');

app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    // 订单链接里带访问密钥，禁止把来源地址发给任何其他网站
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  // 仅在 HTTPS 站点下发 HSTS：告诉浏览器以后只用 HTTPS 访问
  if (config.baseUrl.startsWith('https://')) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  // 接口返回的订单信息不允许被浏览器或中间代理缓存
  if (req.path.startsWith('/api/') || req.path.startsWith('/mock-pay/')) res.set('Cache-Control', 'no-store');
  // 后台页面不让搜索引擎收录
  // 订单页的网址里带访问密钥，同样不能被收录
  if (req.path.startsWith('/admin') || req.path.startsWith('/api/admin') || req.path.startsWith('/order')) res.set('X-Robots-Tag', 'noindex, nofollow');
  next();
});

app.use(express.json({ limit: '64kb' }));
// 注意：表单（urlencoded）解析只在易支付回调路由上启用（见 routes/public.ts），
// 其他接口只接受 JSON，避免第三方网页用普通表单跨站提交。

// 健康检查：进程活着且数据库可用才算健康（Docker 据此判断是否需要重启容器）
app.get('/healthz', (_req, res) => {
  get('SELECT 1')
    .then(() => res.json({ ok: true }))
    .catch(() => res.status(503).json({ ok: false }));
});

app.use('/api', publicRoutes);
app.use('/api/admin', adminRoutes);
if (payments.enabled.includes('mock')) app.use(mockPayRouter());
// 首页由服务端填入套餐内容后输出（必须排在静态文件之前，否则会直接返回未填充的模板）
app.get(['/', '/index.html'], (_req, res, next) => {
  renderHome(cachedPlans)
    .then((html) => res.set('Cache-Control', 'no-cache').type('html').send(html))
    .catch(next);
});
app.get('/robots.txt', (_req, res) => void res.type('text/plain').send(robotsTxt()));
app.get('/sitemap.xml', (_req, res) => void res.type('application/xml').send(sitemapXml()));
app.use(express.static(config.publicDir));

const errorHandler: ErrorRequestHandler = (err: { status?: number; message?: string }, _req, res, _next) => {
  const status = err.status ?? 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? '服务器错误' : err.message });
};
app.use(errorHandler);

// 启动前执行数据库迁移（自动建表 / 升级表结构）
const applied = await migrate();
if (applied.length) console.log(`[db] 已执行迁移: ${applied.join(', ')}`);

const server = app.listen(config.port, () => {
  console.log(`gpt-topup listening on ${config.baseUrl} (port ${config.port})`);
  console.log(`payment: ${payments.enabled.join(', ')} | upstream: ${config.upstream.driver} | db schema: ${config.dbSchema}`);
  worker.start();
});
// 防慢速连接攻击（Slowloris）：请求头必须在 10 秒内发完，整个请求 20 秒内完成；空闲长连接 5 秒后关闭
server.headersTimeout = 10_000;
server.requestTimeout = 20_000;
server.keepAliveTimeout = 5_000;

server.on('error', async (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[server] 端口 ${config.port} 已被占用：可能已有一个服务在运行。请先关闭它，或在 .env 中修改 PORT。`);
  } else {
    console.error('[server] 启动失败', err);
  }
  await closeDb();
  process.exit(1);
});

// 优雅退出：停止接收新请求 → 等当前批次订单处理完 → 关闭数据库连接
let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  console.log(`[server] 收到 ${signal}，正在退出…`);
  server.close();
  await worker.stop();
  await closeDb();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
