// 易支付 V2 接口（SHA256WithRSA 签名）
// 文档: https://www.ezfp.cn/doc/index.html
//
// 支付宝、微信两个支付选项都走同一个易支付商户，区别只是下单时的 type（alipay / wxpay）。
// 金额在易支付里以「元」字符串传递（如 "1.00"），本系统内部统一用「分」。
import crypto from 'node:crypto';
import config from '../config.ts';
import type { PayChannel, PaymentNotify, PaymentProvider } from '../types.ts';

const cfg = config.payment.epay;

type Params = Record<string, unknown>;

interface EpayResponse {
  code?: number | string;
  msg?: string;
  trade_no?: string;
  out_trade_no?: string;
  pay_type?: string;
  pay_info?: string;
  status?: number | string;
  money?: string;
  sign?: string;
  [k: string]: unknown;
}

// ---------- 签名 ----------

/** 待签名字符串：非空参数（不含 sign、sign_type 及数组/对象），按参数名 ASCII 升序，拼成 k=v&k=v */
function signContent(params: Params): string {
  return Object.keys(params)
    .filter((k) => {
      const v = params[k];
      return k !== 'sign' && k !== 'sign_type' && v !== undefined && v !== null && v !== '' && typeof v !== 'object';
    })
    .sort()
    .map((k) => `${k}=${String(params[k])}`)
    .join('&');
}

/** 平台后台给出的密钥通常不带 PEM 头尾，这里两种格式都兼容（PKCS#8 / PKCS#1） */
function loadKey(raw: string, kind: 'private' | 'public'): crypto.KeyObject {
  const body = raw.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const lines = body.match(/.{1,64}/g)?.join('\n') ?? '';
  const candidates = raw.includes('-----BEGIN')
    ? [raw]
    : kind === 'private'
      ? [`-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----`, `-----BEGIN RSA PRIVATE KEY-----\n${lines}\n-----END RSA PRIVATE KEY-----`]
      : [`-----BEGIN PUBLIC KEY-----\n${lines}\n-----END PUBLIC KEY-----`, `-----BEGIN RSA PUBLIC KEY-----\n${lines}\n-----END RSA PUBLIC KEY-----`];
  for (const pem of candidates) {
    try {
      return kind === 'private' ? crypto.createPrivateKey(pem) : crypto.createPublicKey(pem);
    } catch {
      // 换下一种格式再试
    }
  }
  throw new Error(kind === 'private' ? 'EPAY_MERCHANT_PRIVATE_KEY 格式无法识别' : 'EPAY_PLATFORM_PUBLIC_KEY 格式无法识别');
}

let keys: { privateKey: crypto.KeyObject; publicKey: crypto.KeyObject } | undefined;
/** 首次使用时才解析密钥：只启用 mock 支付时不需要配置易支付 */
function getKeys() {
  keys ??= { privateKey: loadKey(cfg.merchantPrivateKey, 'private'), publicKey: loadKey(cfg.platformPublicKey, 'public') };
  return keys;
}

export function sign(params: Params): string {
  return crypto.createSign('RSA-SHA256').update(signContent(params), 'utf8').sign(getKeys().privateKey, 'base64');
}

/** 用平台公钥验签（接口返回数据、异步通知都要验） */
export function verify(params: Params): boolean {
  const signature = params.sign;
  if (typeof signature !== 'string' || !signature) return false;
  try {
    return crypto.createVerify('RSA-SHA256').update(signContent(params), 'utf8').verify(getKeys().publicKey, signature, 'base64');
  } catch {
    return false;
  }
}

// ---------- 请求 ----------

const timestamp = (): string => String(Math.floor(Date.now() / 1000));

async function call(path: string, biz: Record<string, string>): Promise<EpayResponse> {
  const params: Record<string, string> = { pid: cfg.pid, ...biz, timestamp: timestamp() };
  params.sign = sign(params);
  params.sign_type = 'RSA';
  const res = await fetch(`${cfg.apiUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let json: EpayResponse;
  try {
    json = JSON.parse(text) as EpayResponse;
  } catch {
    throw new Error(`易支付返回了无法解析的内容（HTTP ${res.status}）`);
  }
  // 成功的返回带签名，必须验签，防止支付状态被伪造；失败的返回可能不带签名，原样交给调用方判断
  if (Number(json.code) === 0 && !verify(json)) throw new Error('易支付返回数据验签失败');
  return json;
}

const yuan = (cents: number): string => (cents / 100).toFixed(2);
const cents = (yuanStr: unknown): number => Math.round(Number(yuanStr) * 100);

/** 二维码内容（微信 weixin://、支付宝 qr.alipay.com）在页面上画成二维码；其他链接给出跳转按钮 */
const QR_CONTENT = /^(weixin:\/\/|wxp:\/\/|https?:\/\/qr\.alipay\.com\/|alipays?:\/\/)/i;

// ---------- 渠道 ----------

/**
 * 创建一个走易支付的支付渠道。
 * @param name  本系统里的渠道名（订单表 pay_channel 存的值），沿用 alipay / wechat，前台不用改
 * @param type  易支付的支付方式：alipay 支付宝 / wxpay 微信支付
 */
export function createEpayProvider(name: Extract<PayChannel, 'alipay' | 'wechat'>, label: string, type: 'alipay' | 'wxpay'): PaymentProvider {
  return {
    name,
    label,

    async createQr({ orderNo, amountCents, subject, mobile, clientIp }) {
      const base = {
        type,
        out_trade_no: orderNo,
        notify_url: `${config.baseUrl}/api/notify/epay`,
        // 付完款回到「我的订单」：这个地址会经过易支付，所以不带订单的访问密钥
        return_url: `${config.baseUrl}/orders.html`,
        name: subject.slice(0, 60),
        money: yuan(amountCents),
        clientip: clientIp || '127.0.0.1',
      };
      // 手机：用「跳转支付」，平台只返回一个付款链接。用户在手机上打开后，由平台按真实的手机环境
      // 决定走支付宝 / 微信 H5 还是收银台（易支付文档推荐的做法）。
      // 不用 web + device=mobile：实测这个商户的通道对它返回「系统异常无法完成付款」，
      // 而失败后再用同一个订单号重下，平台可能当作重复订单拒绝，所以手机上直接走 jump。
      // 电脑：通用网页支付，平台返回二维码内容或付款页链接（页面上都会画成二维码）
      let r = await call('/api/pay/create', mobile ? { ...base, method: 'jump' } : { ...base, method: 'web', device: 'pc' });
      // 返回的是我们无法直接展示的形式（如 html 表单），改用只返回跳转链接的方式再下一次
      if (!mobile && Number(r.code) === 0 && !['qrcode', 'jump', 'urlscheme'].includes(String(r.pay_type))) {
        r = await call('/api/pay/create', { ...base, method: 'jump' });
      }
      if (Number(r.code) !== 0 || !r.pay_info) throw new Error(`易支付下单失败: ${r.msg || `code=${r.code}`}`);
      return { qr: String(r.pay_info) };
    },

    isLink: (payQr) => !QR_CONTENT.test(payQr),

    async query(orderNo) {
      const r = await call('/api/pay/query', { out_trade_no: orderNo });
      // 订单在平台上不存在（用户还没打开过付款页）等情况都视为未支付
      if (Number(r.code) !== 0) return { paid: false };
      // 状态：0 未支付 / 1 已支付 / 2 已退款 / 3 已冻结 / 4 预授权 —— 只有 1 算到账
      return { paid: Number(r.status) === 1, tradeNo: r.trade_no, amountCents: cents(r.money) };
    },

    async close(orderNo) {
      const r = await call('/api/pay/close', { out_trade_no: orderNo });
      if (Number(r.code) !== 0) throw new Error(`易支付关闭订单失败: ${r.msg || `code=${r.code}`}（部分支付通道不支持关闭订单）`);
    },
  };
}

/**
 * 解析易支付的异步通知（GET 参数，也兼容 POST 表单）。
 * 校验：签名、商户号、交易状态；金额由 markPaid 与订单金额比对。
 */
export function parseNotify(params: Record<string, unknown>): PaymentNotify {
  if (!verify(params)) throw new Error('易支付通知验签失败');
  if (String(params.pid) !== cfg.pid) throw new Error('易支付通知商户号不匹配');
  const orderNo = typeof params.out_trade_no === 'string' ? params.out_trade_no : '';
  if (!orderNo) throw new Error('易支付通知缺少订单号');
  return {
    orderNo,
    tradeNo: typeof params.trade_no === 'string' ? params.trade_no : '',
    amountCents: cents(params.money),
    paid: params.trade_status === 'TRADE_SUCCESS',
  };
}
