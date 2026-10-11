// 支付宝 当面付 - 扫码支付（alipay.trade.precreate）
// 文档: https://opendocs.alipay.com/open/194/106078
import crypto from 'node:crypto';
import config from '../config.ts';
import type { PaymentProvider } from '../types.ts';

const cfg = config.payment.alipay;

type Params = Record<string, string | undefined>;

interface AlipayResponse {
  code?: string;
  msg?: string;
  sub_msg?: string;
  qr_code?: string;
  trade_status?: string;
  trade_no?: string;
  total_amount?: string;
}

const pem = (key: string, type: string): string =>
  key.includes('-----BEGIN')
    ? key
    : `-----BEGIN ${type}-----\n${(key.replace(/\s+/g, '').match(/.{1,64}/g) ?? []).join('\n')}\n-----END ${type}-----`;

function beijingTime(d = new Date()): string {
  return new Date(d.getTime() + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19);
}

function signContent(params: Params): string {
  return Object.keys(params)
    .filter((k) => k !== 'sign' && params[k] !== undefined && params[k] !== null && params[k] !== '')
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
}

function sign(params: Params): string {
  return crypto.createSign('RSA-SHA256').update(signContent(params), 'utf8').sign(pem(cfg.privateKey, 'PRIVATE KEY'), 'base64');
}

function verify(params: Params): boolean {
  const { sign: signature, sign_type: _signType, ...rest } = params;
  if (!signature) return false;
  return crypto
    .createVerify('RSA-SHA256')
    .update(signContent(rest), 'utf8')
    .verify(pem(cfg.alipayPublicKey, 'PUBLIC KEY'), signature, 'base64');
}

async function call(method: string, biz: object, extra: Params = {}): Promise<AlipayResponse | undefined> {
  const params: Record<string, string> = {
    app_id: cfg.appId,
    method,
    format: 'JSON',
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp: beijingTime(),
    version: '1.0',
    ...(extra as Record<string, string>),
    biz_content: JSON.stringify(biz),
  };
  params.sign = sign(params);
  const res = await fetch(cfg.gateway, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(15000),
  });
  const json = (await res.json()) as Record<string, AlipayResponse>;
  return json[`${method.replace(/\./g, '_')}_response`];
}

const yuan = (cents: number): string => (cents / 100).toFixed(2);
const cents = (yuanStr: string | undefined): number => Math.round(Number(yuanStr) * 100);
const isPaid = (status: string | undefined): boolean => status === 'TRADE_SUCCESS' || status === 'TRADE_FINISHED';

const alipay: PaymentProvider = {
  name: 'alipay',
  label: '支付宝',

  async createQr({ orderNo, amountCents, subject, expireAt }) {
    const minutes = Math.max(1, Math.floor((expireAt - Date.now()) / 60000));
    const r = await call(
      'alipay.trade.precreate',
      { out_trade_no: orderNo, total_amount: yuan(amountCents), subject, timeout_express: `${minutes}m` },
      { notify_url: `${config.baseUrl}/api/notify/alipay` },
    );
    if (r?.code !== '10000' || !r.qr_code) throw new Error(`支付宝下单失败: ${r?.sub_msg || r?.msg || 'unknown'}`);
    return { qr: r.qr_code };
  },

  async query(orderNo) {
    const r = await call('alipay.trade.query', { out_trade_no: orderNo });
    if (r?.code !== '10000') return { paid: false };
    return { paid: isPaid(r.trade_status), tradeNo: r.trade_no, amountCents: cents(r.total_amount) };
  },

  /** 异步通知：req.body 为 urlencoded 解析后的对象 */
  parseNotify(req) {
    const p = req.body ?? {};
    if (!verify(p)) throw new Error('支付宝通知验签失败');
    if (p.app_id !== cfg.appId) throw new Error('支付宝通知 app_id 不匹配');
    if (!p.out_trade_no) throw new Error('支付宝通知缺少订单号');
    return {
      orderNo: p.out_trade_no,
      tradeNo: p.trade_no ?? '',
      amountCents: cents(p.total_amount),
      paid: isPaid(p.trade_status),
    };
  },
  ackSuccess: (res) => res.type('text').send('success'),
  ackFail: (res) => res.type('text').send('fail'),
};

export default alipay;
