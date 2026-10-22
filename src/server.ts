import express, { type ErrorRequestHandler } from 'express';
import config from './config.ts';
import routes from './routes.ts';
import { renderHome, robotsTxt, sitemapXml } from './home.ts';

const app = express();
app.set('trust proxy', config.trustProxy);
app.disable('x-powered-by');

// ---------- 安全响应头 ----------
// 页面使用内联脚本和样式，所以 script/style 允许 'unsafe-inline'；
// 其余全部收紧：不允许加载外部资源、不允许向外部域名发请求（即使出现 XSS 也难以把数据传出去）、不允许被其他网站嵌入。
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    // 页面网址里带查询凭据，禁止把来源地址发给任何其他网站
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  // 仅在 HTTPS 站点下发 HSTS：告诉浏览器以后只用 HTTPS 访问
  if (config.baseUrl.startsWith('https://')) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  // 接口返回的内容不允许被浏览器或中间代理缓存
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
  next();
});

// 提交时带整段 session JSON（最长 10 万字符，含中文时字节数更多），请求体上限按此留足。
// 只解析 JSON、不解析表单：避免第三方网页用普通表单跨站提交。
app.use(express.json({ limit: '256kb' }));

// 健康检查（Docker 据此判断是否需要重启容器）
app.get('/healthz', (_req, res) => void res.json({ ok: true }));

app.use('/api', routes);
// 首页由服务端填入站点地址后输出（必须排在静态文件之前，否则会直接返回未填充的模板）
app.get(['/', '/index.html'], (_req, res) => {
  res.set('Cache-Control', 'no-cache').type('html').send(renderHome());
});
app.get('/robots.txt', (_req, res) => void res.type('text/plain').send(robotsTxt()));
app.get('/sitemap.xml', (_req, res) => void res.type('application/xml').send(sitemapXml()));
app.use(express.static(config.publicDir));

const errorHandler: ErrorRequestHandler = (err: { status?: number; message?: string }, _req, res, _next) => {
  const status = err.status ?? 500;
  if (status >= 500 && !(err instanceof Error && 'status' in err)) console.error(err);
  res.status(status).json({ error: err.status ? err.message : '服务器错误' });
};
app.use(errorHandler);

const server = app.listen(config.port, () => {
  console.log(`gpt-topup listening on ${config.baseUrl} (port ${config.port}) | upstream: ${config.upstream.baseUrl}`);
});
// 防慢速连接攻击（Slowloris）：请求头必须在 10 秒内发完，整个请求 20 秒内收完；空闲长连接 5 秒后关闭
server.headersTimeout = 10_000;
server.requestTimeout = 20_000;
server.keepAliveTimeout = 5_000;

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[server] 端口 ${config.port} 已被占用：可能已有一个服务在运行。请先关闭它，或在 .env 中修改 PORT。`);
  } else {
    console.error('[server] 启动失败', err);
  }
  process.exit(1);
});

// 优雅退出：停止接收新请求，等正在处理的请求结束
function shutdown(signal: string): void {
  console.log(`[server] 收到 ${signal}，正在退出…`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
