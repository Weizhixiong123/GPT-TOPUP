import fs from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const env = (k: string, d: string): string => {
  const v = process.env[k];
  return v === undefined || v === '' ? d : v;
};
const num = (k: string, d: number): number => Number(env(k, String(d)));

function parseTrustProxy(v: string): boolean | number | string {
  if (v === 'false') return false;
  if (v === 'true') return true;
  return /^\d+$/.test(v) ? Number(v) : v;
}

const isProd = process.env.NODE_ENV === 'production';

const config = {
  isProd,
  port: num('PORT', 3000),
  baseUrl: env('BASE_URL', 'http://localhost:3000'),
  publicDir: path.join(root, 'public'),

  // 反向代理信任设置（决定 req.ip 取值）：默认只信任本机代理（如同机 Nginx），防止伪造 X-Forwarded-For 绕过限流
  // 可填 loopback / 代理 IP / 跳数数字；未使用反向代理时设为 false
  trustProxy: parseTrustProxy(env('TRUST_PROXY', 'loopback')),

  antiAbuse: {
    // 提交充值的频率限制（同一 IP；校园网/公司网多人共用出口 IP 时可适当调大）
    perIpPerMin: num('REDEEM_PER_IP_PER_MIN', 10),
    perIpPerHour: num('REDEEM_PER_IP_PER_HOUR', 60),
  },

  // 前台「联系客服」小窗里展示的内容，填了哪项就显示哪项
  support: {
    wechat: env('SUPPORT_WECHAT', ''),
    qq: env('SUPPORT_QQ', ''),
    // Telegram 用户名，不带 @
    telegram: env('SUPPORT_TELEGRAM', '').replace(/^@/, ''),
    email: env('SUPPORT_EMAIL', ''),
    hours: env('SUPPORT_HOURS', ''),
    // 客服二维码图片：放到 public/ 下，这里填站内路径，如 /kefu.png
    qr: env('SUPPORT_QR', ''),
    note: env('SUPPORT_NOTE', ''),
  },

  // 上游（aiaiyg.com）。本站只做中转，不保存任何数据
  upstream: {
    baseUrl: env('UPSTREAM_BASE_URL', 'https://aiaiyg.com'),
    timeoutMs: num('UPSTREAM_TIMEOUT_MS', 15000),
  },
};

try {
  new URL(config.baseUrl);
  new URL(config.upstream.baseUrl);
} catch {
  throw new Error('BASE_URL / UPSTREAM_BASE_URL 格式不正确，应形如 https://example.com');
}
if (isProd && !config.baseUrl.startsWith('https://')) {
  throw new Error('生产环境的 BASE_URL 必须是 https:// 开头（用户的登录信息不能走明文 HTTP）');
}

export default config;
