// 支付宝。按 ALIPAY_PRODUCT 支持三种已签约产品：
//   f2f  当面付          alipay.trade.precreate  → 返回二维码内容，页面直接显示二维码
//   page 电脑网站支付    alipay.trade.page.pay   → 返回收银台链接，用户跳转到支付宝页面付款
//   wap  手机网站支付    alipay.trade.wap.pay    → 同上，手机端可直接拉起支付宝 App
// 查询（alipay.trade.query）和异步通知三种产品通用。
// 文档: https://opendocs.alipay.com/open/194/106078 、https://opendocs.alipay.com/open/270/105899
import crypto from 'node:crypto';
import config from '../config.ts';
import type { PaymentProvider } from '../types.ts';

const cfg = config.payment.alipay;

type Params = Record<string, string | undefined>;

interface AlipayResponse {
  code?: string;
  msg?: string;
  sub_msg?: string;
  sub_code?: string;
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

/** 公共请求参数 + 业务参数，并签名 */
function signedParams(method: string, biz: object, extra: Params = {}): Record<string, string> {
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
  return params;
}

async function call(method: string, biz: object, extra: Params = {}): Promise<AlipayResponse | undefined> {
  const params = signedParams(method, biz, extra);
  const res = await fetch(cfg.gateway, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(15000),
  });
  const json = (await res.json()) as Record<string, AlipayResponse>;
  return json[`${method.replace(/\./g, '_')}_response`];
}

/** 嵌入式二维码的边长（像素），订单页里的框按这个尺寸留位置 */
const EMBED_QR_WIDTH = 200;
const yuan = (cents: number): string => (cents / 100).toFixed(2);
const cents = (yuanStr: string | undefined): number => Math.round(Number(yuanStr) * 100);
const isPaid = (status: string | undefined): boolean => status === 'TRADE_SUCCESS' || status === 'TRADE_FINISHED';

const alipay: PaymentProvider = {
  name: 'alipay',
  label: '支付宝',

  async createQr({ orderNo, amountCents, subject, expireAt, mobile }) {
    const minutes = Math.max(1, Math.floor((expireAt - Date.now()) / 60000));
    const notify = { notify_url: `${config.baseUrl}/api/notify/alipay` };

    // 网站支付：不需要先调接口，把签好名的参数拼成收银台链接即可，用户打开链接时支付宝才创建交易
    const web = mobile && cfg.products.includes('wap') ? 'wap' : cfg.products.includes('page') ? 'page' : cfg.products.includes('wap') ? 'wap' : null;
    if (web && !cfg.products.includes('f2f')) {
      // 电脑上用「嵌入式二维码」：支付宝只返回一个二维码，我们把它嵌在订单页里，用户不用离开本站。
      // 手机上二维码没法自己扫自己，仍然给完整的收银台页面。
      const embed = web === 'page' && !mobile;
      const params = signedParams(
        web === 'wap' ? 'alipay.trade.wap.pay' : 'alipay.trade.page.pay',
        {
          out_trade_no: orderNo,
          total_amount: yuan(amountCents),
          subject,
          product_code: web === 'wap' ? 'QUICK_WAP_WAY' : 'FAST_INSTANT_TRADE_PAY',
          // 用绝对截止时间而不是「多少分钟内」：后者从用户打开链接时才开始计时，
          // 旧链接留到订单过期之后再打开仍然能付款
          time_expire: beijingTime(new Date(expireAt)),
          ...(embed ? { qr_pay_mode: '4', qrcode_width: EMBED_QR_WIDTH } : {}),
        },
        // 跳转到收银台的：付完款支付宝把用户带回「我的订单」（不带订单的访问密钥，这个地址会经过支付宝）。
        // 嵌入的不设回跳地址：否则付款后支付宝会在那个小框里打开我们的页面
        embed ? notify : { ...notify, return_url: `${config.baseUrl}/orders.html` },
      );
      return { qr: `${cfg.gateway}?${new URLSearchParams(params).toString()}` };
    }

    const r = await call(
      'alipay.trade.precreate',
      { out_trade_no: orderNo, total_amount: yuan(amountCents), subject, timeout_express: `${minutes}m` },
      notify,
    );
    if (r?.code !== '10000' || !r.qr_code) throw new Error(`支付宝下单失败: ${r?.sub_msg || r?.msg || 'unknown'}`);
    return { qr: r.qr_code };
  },

  isLink: (payQr) => payQr.startsWith(`${cfg.gateway}?`),
  isEmbed: (payQr) => payQr.startsWith(`${cfg.gateway}?`) && payQr.includes('qr_pay_mode'),

  async query(orderNo) {
    const r = await call('alipay.trade.query', { out_trade_no: orderNo });
    if (r?.code !== '10000') return { paid: false };
    return { paid: isPaid(r.trade_status), tradeNo: r.trade_no, amountCents: cents(r.total_amount) };
  },

  async close(orderNo) {
    const r = await call('alipay.trade.close', { out_trade_no: orderNo });
    // 用户还没扫码 / 打开过收银台时，支付宝那边还没有这笔交易，不需要关
    if (r?.code === '10000' || r?.sub_code === 'ACQ.TRADE_NOT_EXIST') return;
    throw new Error(`支付宝关闭交易失败: ${r?.sub_msg || r?.msg || 'unknown'}`);
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
