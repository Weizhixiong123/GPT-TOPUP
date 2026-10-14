import fs from 'node:fs';
import path from 'node:path';
import type { PayChannel } from './types.ts';

const root = path.join(import.meta.dirname, '..');
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const env = (k: string, d: string): string => {
  const v = process.env[k];
  return v === undefined || v === '' ? d : v;
};
const num = (k: string, d: number): number => Number(env(k, String(d)));
const readKey = (v: string): string => (v && fs.existsSync(v) ? fs.readFileSync(v, 'utf8') : v.replace(/\\n/g, '\n'));

function parseTrustProxy(v: string): boolean | number | string {
  if (v === 'false') return false;
  if (v === 'true') return true;
  return /^\d+$/.test(v) ? Number(v) : v;
}

const PAY_CHANNELS: readonly PayChannel[] = ['mock', 'alipay', 'wechat'];
const enabledChannels = env('PAYMENT_PROVIDERS', 'mock')
  .split(',')
  .map((s) => s.trim())
  .filter((s): s is PayChannel => {
    // none：不接入任何在线支付，所有套餐都走人工（联系客服购买）
    if (!s || s === 'none') return false;
    if (!(PAY_CHANNELS as readonly string[]).includes(s)) {
      console.warn(`[config] 未知支付渠道 ${s}，已忽略`);
      return false;
    }
    return true;
  });

const upstreamDriver = env('UPSTREAM_DRIVER', 'mock');
if (upstreamDriver !== 'mock' && upstreamDriver !== 'http' && upstreamDriver !== 'aiaiyg') throw new Error(`未知上游驱动 ${upstreamDriver}`);

const isProd = process.env.NODE_ENV === 'production';

const config = {
  isProd,
  port: num('PORT', 3000),
  baseUrl: env('BASE_URL', 'http://localhost:3000'),
  // PostgreSQL 连接串（Supabase：Connect → Session pooler）
  databaseUrl: env('DATABASE_URL', ''),
  // 业务表所在 schema，默认 topup（不放 public，避免被 Supabase HTTP 接口暴露）
  dbSchema: env('DB_SCHEMA', 'topup'),
  dbPoolSize: num('DB_POOL_SIZE', 10),
  publicDir: path.join(root, 'public'),
  // 用于加密存储用户 Token 的 32 字节密钥（64 位 hex）
  tokenSecret: env('TOKEN_SECRET', ''),
  adminUser: env('ADMIN_USER', 'admin'),
  adminPassword: env('ADMIN_PASSWORD', ''),

  // 反向代理信任设置（决定 req.ip 取值）：默认只信任本机代理（如同机 Nginx），防止伪造 X-Forwarded-For 绕过限流
  // 可填 loopback / 代理 IP / 跳数数字；未使用反向代理时设为 false
  trustProxy: parseTrustProxy(env('TRUST_PROXY', 'loopback')),

  antiAbuse: {
    ordersPerIpPerMin: num('ORDERS_PER_IP_PER_MIN', 5),
    ordersPerIpPerHour: num('ORDERS_PER_IP_PER_HOUR', 30),
    ordersGlobalPerMin: num('ORDERS_GLOBAL_PER_MIN', 120),
    // 同一 IP 同时存在的未支付订单上限（考虑到校园网/公司网共享出口 IP，不宜太小）
    maxPendingPerIp: num('MAX_PENDING_PER_IP', 5),
    // 提交 Token 的频率限制（校园网/公司网多人共用出口 IP 时可适当调大）
    tokenPerIpPerMin: num('TOKEN_PER_IP_PER_MIN', 10),
    tokenPerIpPerHour: num('TOKEN_PER_IP_PER_HOUR', 60),
  },

  // 人工服务套餐的编号（逗号分隔）：这些套餐不能自助下单，前台按钮改为「联系客服购买」
  manualPlanIds: env('MANUAL_PLAN_IDS', '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0),

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

  orderExpireMinutes: num('ORDER_EXPIRE_MINUTES', 15),
  workerIntervalMs: num('WORKER_INTERVAL_MS', 5000),
  redeemQueryIntervalSec: num('REDEEM_QUERY_INTERVAL_SEC', 10),
  redeemMaxQueries: num('REDEEM_MAX_QUERIES', 180),
  redeemMaxSubmitRetries: num('REDEEM_MAX_SUBMIT_RETRIES', 3),

  payment: {
    // mock（开发用模拟支付）| alipay | wechat ；可同时启用多个，逗号分隔。
    // alipay、wechat 都通过易支付收款
    enabled: enabledChannels,
    // 易支付 V2（RSA 签名）。密钥在易支付商户后台 → 个人资料 → API 信息 生成；可填文件路径或单行内容
    epay: {
      apiUrl: env('EPAY_API_URL', 'https://www.ezfp.cn').replace(/\/+$/, ''),
      pid: env('EPAY_PID', ''),
      merchantPrivateKey: readKey(env('EPAY_MERCHANT_PRIVATE_KEY', '')),
      platformPublicKey: readKey(env('EPAY_PLATFORM_PUBLIC_KEY', '')),
    },
  },

  upstream: {
    driver: upstreamDriver as 'mock' | 'http' | 'aiaiyg',
    baseUrl: env('UPSTREAM_BASE_URL', ''),
    apiKey: env('UPSTREAM_API_KEY', ''),
    timeoutMs: num('UPSTREAM_TIMEOUT_MS', 15000),
  },
};

if (!config.databaseUrl) {
  throw new Error('未配置 DATABASE_URL。请在 .env 中填写 PostgreSQL 连接串（Supabase：项目顶部 Connect → Session pooler）');
}
/**
 * 密码含 @ # / ? % 等特殊字符时，连接串无法按 URL 解析。
 * 这里把「用户名:」与最后一个「@」之间的内容视为密码并做 URL 编码，用户可直接粘贴原始密码。
 */
function normalizeDatabaseUrl(raw: string): string {
  try {
    new URL(raw);
    return raw;
  } catch {
    const m = raw.match(/^(postgres(?:ql)?:\/\/)([^:/@]+):(.*)@([^@/]+)(\/[^@]*)?$/);
    if (!m) return raw;
    const [, scheme, user, password = '', host, rest = ''] = m;
    return `${scheme}${user}:${encodeURIComponent(password)}@${host}${rest}`;
  }
}
config.databaseUrl = normalizeDatabaseUrl(config.databaseUrl);

// 提前校验连接串格式；报错信息里绝不输出连接串本身（其中含数据库密码）
try {
  const u = new URL(config.databaseUrl);
  if (!/^postgres(ql)?:$/.test(u.protocol) || !u.hostname) throw new Error();
} catch {
  throw new Error(
    'DATABASE_URL 格式不正确。常见原因：密码中包含 @ # / ? % : 等特殊字符。' +
      '建议在 Supabase 重置为只含字母和数字的密码，或将特殊字符做 URL 编码（encodeURIComponent）后再填写。',
  );
}
if (!/^[a-z_][a-z0-9_]*$/.test(config.dbSchema)) throw new Error('DB_SCHEMA 只能包含小写字母、数字和下划线');
// 启用了支付宝或微信（都走易支付）时，易支付配置必须完整
if (config.payment.enabled.some((c) => c === 'alipay' || c === 'wechat')) {
  const e = config.payment.epay;
  const missing = [
    !e.pid && 'EPAY_PID',
    !e.merchantPrivateKey && 'EPAY_MERCHANT_PRIVATE_KEY',
    !e.platformPublicKey && 'EPAY_PLATFORM_PUBLIC_KEY',
  ].filter(Boolean);
  if (missing.length) throw new Error(`已启用支付宝/微信支付（通过易支付收款），但缺少配置：${missing.join('、')}`);
  if (!/^\d+$/.test(e.pid)) throw new Error('EPAY_PID（商户 ID）应为纯数字');
  if (!/^https:\/\//.test(e.apiUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(e.apiUrl)) {
    throw new Error('EPAY_API_URL 必须是 https:// 开头（签名和订单数据不能走明文 HTTP）');
  }
}

/** 对外地址是否为本机（localhost / 127.0.0.1 / ::1）。不是本机就视为对公网提供服务 */
const isLocalBaseUrl = (() => {
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(config.baseUrl).hostname);
  } catch {
    throw new Error('BASE_URL 格式不正确，应形如 https://example.com');
  }
})();
/** 对公网提供服务：显式设置了 NODE_ENV=production，或者对外地址不是本机 */
const isPublic = isProd || !isLocalBaseUrl;

if (!/^[0-9a-f]{64}$/i.test(config.tokenSecret) || /^(.)\1+$/.test(config.tokenSecret)) {
  if (isPublic) {
    throw new Error('TOKEN_SECRET 必须是随机的 64 位 hex（32 字节），可用 `node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"` 生成');
  }
  console.warn('[config] TOKEN_SECRET 未配置，使用开发用固定密钥 —— 生产环境务必配置！');
  config.tokenSecret = '0'.repeat(64);
}

// 模拟支付会开放 /mock-pay，任何人都能把订单标记为已支付。
// 双重保险：不只看 NODE_ENV（部署时可能忘记设置），只要对外地址不是本机就禁止启用。
if (isPublic && config.payment.enabled.includes('mock')) {
  throw new Error('对公网提供服务时禁止启用 mock 支付渠道（任何人都能免费把订单标记为已支付），请修改 PAYMENT_PROVIDERS');
}
if (isPublic && config.upstream.driver === 'mock') {
  throw new Error('对公网提供服务时禁止使用 mock 上游（不会真正充值），请配置 UPSTREAM_DRIVER=http');
}
if (isProd && !config.baseUrl.startsWith('https://')) {
  throw new Error('生产环境的 BASE_URL 必须是 https:// 开头（后台密码、用户 Token 都不能走明文 HTTP）');
}

const WEAK_PASSWORDS = ['admin', 'password', '123456', '12345678', 'admin123', 'qwerty', '111111', '000000'];
function isWeakPassword(p: string): boolean {
  return p.length < 12 || WEAK_PASSWORDS.includes(p.toLowerCase()) || p.toLowerCase() === config.adminUser.toLowerCase() || /^(.)\1+$/.test(p);
}

if (!config.adminPassword) {
  if (isPublic) throw new Error('必须配置 ADMIN_PASSWORD');
  console.warn('[config] ADMIN_PASSWORD 未配置，开发环境默认 admin/admin');
  config.adminPassword = 'admin';
} else if (isWeakPassword(config.adminPassword)) {
  if (isPublic) {
    throw new Error('ADMIN_PASSWORD 强度不够：至少 12 位，且不能是常见弱密码或与用户名相同。可用 `node -e "console.log(require(\'crypto\').randomBytes(18).toString(\'base64url\'))"` 生成');
  }
  console.warn('[config] ADMIN_PASSWORD 是弱密码，仅限本地开发使用，上线前必须更换');
}

export default config;
