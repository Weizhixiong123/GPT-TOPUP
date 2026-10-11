// 微信支付 APIv3 - Native 扫码支付
// 文档: https://pay.weixin.qq.com/doc/v3/merchant/4012791874
import crypto from 'node:crypto';
import config from '../config.ts';
import type { PaymentProvider } from '../types.ts';

const cfg = config.payment.wechat;
const HOST = 'https://api.mch.weixin.qq.com';

interface WechatTransaction {
  mchid?: string;
  out_trade_no?: string;
  transaction_id?: string;
  trade_state?: string;
  amount?: { total?: number };
}

interface EncryptedResource {
  ciphertext: string;
  associated_data?: string;
  nonce: string;
}

function authorization(method: string, urlPath: string, body: string): string {
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const message = `${method}\n${urlPath}\n${ts}\n${nonce}\n${body}\n`;
  const signature = crypto.createSign('RSA-SHA256').update(message).sign(cfg.privateKey, 'base64');
  return `WECHATPAY2-SHA256-RSA2048 mchid="${cfg.mchId}",nonce_str="${nonce}",signature="${signature}",timestamp="${ts}",serial_no="${cfg.serialNo}"`;
}

async function request<T>(method: 'GET' | 'POST', urlPath: string, payload?: object): Promise<{ status: number; json: T & { message?: string } }> {
  const body = payload ? JSON.stringify(payload) : '';
  const res = await fetch(HOST + urlPath, {
    method,
    headers: {
      Authorization: authorization(method, urlPath, body),
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'gpt-topup',
    },
    body: payload ? body : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : {}) as T & { message?: string } };
}

function rfc3339Beijing(ms: number): string {
  return `${new Date(ms + 8 * 3600e3).toISOString().slice(0, 19)}+08:00`;
}

function decryptResource({ ciphertext, associated_data, nonce }: EncryptedResource): WechatTransaction {
  const buf = Buffer.from(ciphertext, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(cfg.apiV3Key, 'utf8'), Buffer.from(nonce, 'utf8'));
  decipher.setAuthTag(buf.subarray(buf.length - 16));
  if (associated_data) decipher.setAAD(Buffer.from(associated_data, 'utf8'));
  return JSON.parse(Buffer.concat([decipher.update(buf.subarray(0, buf.length - 16)), decipher.final()]).toString('utf8'));
}

const wechat: PaymentProvider = {
  name: 'wechat',
  label: '微信支付',

  async createQr({ orderNo, amountCents, subject, expireAt }) {
    const { status, json } = await request<{ code_url?: string }>('POST', '/v3/pay/transactions/native', {
      appid: cfg.appId,
      mchid: cfg.mchId,
      description: subject.slice(0, 127),
      out_trade_no: orderNo,
      time_expire: rfc3339Beijing(expireAt),
      notify_url: `${config.baseUrl}/api/notify/wechat`,
      amount: { total: amountCents, currency: 'CNY' },
    });
    if (status !== 200 || !json.code_url) throw new Error(`微信下单失败: ${json.message || status}`);
    return { qr: json.code_url };
  },

  async query(orderNo) {
    const { status, json } = await request<WechatTransaction>(
      'GET',
      `/v3/pay/transactions/out-trade-no/${encodeURIComponent(orderNo)}?mchid=${cfg.mchId}`,
    );
    if (status !== 200) return { paid: false };
    return { paid: json.trade_state === 'SUCCESS', tradeNo: json.transaction_id, amountCents: json.amount?.total };
  },

  /** 异步通知：需要原始 body（req.rawBody）验签 */
  parseNotify(req) {
    const raw = req.rawBody;
    const ts = req.get('Wechatpay-Timestamp');
    const nonce = req.get('Wechatpay-Nonce');
    const signature = req.get('Wechatpay-Signature');
    const serial = req.get('Wechatpay-Serial');
    if (!raw || !ts || !nonce || !signature) throw new Error('微信通知缺少签名头');
    if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) throw new Error('微信通知时间戳过期');
    if (cfg.platformPublicKeyId && serial !== cfg.platformPublicKeyId) throw new Error('微信通知公钥 ID 不匹配');
    const ok = crypto
      .createVerify('RSA-SHA256')
      .update(`${ts}\n${nonce}\n${raw}\n`)
      .verify(cfg.platformPublicKey, signature, 'base64');
    if (!ok) throw new Error('微信通知验签失败');

    const body = JSON.parse(raw) as { resource: EncryptedResource };
    const tx = decryptResource(body.resource);
    if (tx.mchid !== cfg.mchId) throw new Error('微信通知商户号不匹配');
    if (!tx.out_trade_no) throw new Error('微信通知缺少订单号');
    return {
      orderNo: tx.out_trade_no,
      tradeNo: tx.transaction_id ?? '',
      amountCents: tx.amount?.total ?? -1,
      paid: tx.trade_state === 'SUCCESS',
    };
  },
  ackSuccess: (res) => res.status(204).end(),
  ackFail: (res) => res.status(500).json({ code: 'FAIL', message: 'error' }),
};

export default wechat;
