import express, { type Request, type Response, type NextFunction } from 'express';
import QRCode from 'qrcode';
import config from '../config.ts';
import * as payments from '../payments/index.ts';
import mockPay from '../payments/mock.ts';
import * as orders from '../services/orders.ts';
import { ipKey, rateLimit } from '../ratelimit.ts';
import { HttpError, type NotifyRequest } from '../types.ts';

const router = express.Router();
const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };
const MIN = 60e3;
const HOUR = 3600e3;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

// 二维码图片缓存：订单页每 3 秒轮询一次，避免每次都重新生成图片
const qrCache = new Map<string, string>();
async function qrImage(text: string): Promise<string> {
  let img = qrCache.get(text);
  if (!img) {
    img = await QRCode.toDataURL(text, { margin: 1, width: 240 });
    if (qrCache.size >= 500) qrCache.delete(qrCache.keys().next().value as string);
    qrCache.set(text, img);
  }
  return img;
}

// 套餐列表短缓存：首页每次访问都要查库存，缓存 3 秒；并发请求共用同一次查询，防止被刷首页打满数据库
let plansCache: { at: number; data: Promise<Awaited<ReturnType<typeof orders.listPlans>>> } | undefined;
function cachedPlans() {
  if (!plansCache || Date.now() - plansCache.at > 3000) {
    const data = orders.listPlans();
    plansCache = { at: Date.now(), data };
    data.catch(() => (plansCache = undefined)); // 查询失败不缓存
  }
  return plansCache.data;
}

// 订单号 = T + 14 位时间 + 6 位随机数；访问密钥 = 32 位 hex。格式不对直接拒绝，不查数据库
const ORDER_NO_RE = /^T\d{20}$/;
const ACCESS_KEY_RE = /^[0-9a-f]{32}$/;

router.get(
  '/plans',
  rateLimit('plans', [{ scope: 'ip', max: 120, windowMs: MIN }]),
  wrap(async (_req, res) => {
    res.json({ plans: await cachedPlans(), channels: payments.list() });
  }),
);

// 「联系客服」小窗的内容（见 public/support.js）
router.get('/support', rateLimit('support', [{ scope: 'ip', max: 60, windowMs: MIN }]), (_req, res) => {
  res.json(config.support);
});

router.post(
  '/orders',
  rateLimit(
    'create-order',
    [
      { scope: 'ip', max: config.antiAbuse.ordersPerIpPerMin, windowMs: MIN },
      { scope: 'ip', max: config.antiAbuse.ordersPerIpPerHour, windowMs: HOUR },
      // 全站总量兜底，保护支付渠道下单接口不被刷
      { scope: 'global', max: config.antiAbuse.ordersGlobalPerMin, windowMs: MIN },
    ],
    '下单太频繁，请稍后再试',
  ),
  wrap(async (req, res) => {
    // 「同一 IP 未支付订单上限」与限流用同一个标识（IPv6 按 /64 归并）
    const order = await orders.createOrder(Number(req.body.plan_id), str(req.body.channel), ipKey(req.ip));
    res.json({ order_no: order.order_no, access_key: order.access_key });
  }),
);

router.get(
  '/orders/:no',
  // 订单页每 3 秒轮询一次（约 20 次/分钟），「我的订单」页会同时查多个订单，这里留足余量
  rateLimit('query-order', [{ scope: 'ip', max: 150, windowMs: MIN }]),
  wrap(async (req, res) => {
    const no = str(req.params.no);
    const key = str(req.query.key);
    if (!ORDER_NO_RE.test(no) || !ACCESS_KEY_RE.test(key)) throw new HttpError(404, '订单不存在');
    let order = await orders.getForUser(no, key);
    order = await orders.syncPayment(order);
    const view = orders.publicView(order);
    if (view.pay_qr) view.pay_qr_image = await qrImage(view.pay_qr);
    res.json(view);
  }),
);

router.post(
  '/orders/:no/token',
  rateLimit('submit-token', [
    { scope: 'ip', max: config.antiAbuse.tokenPerIpPerMin, windowMs: MIN },
    { scope: 'ip', max: config.antiAbuse.tokenPerIpPerHour, windowMs: HOUR },
  ]),
  wrap(async (req, res) => {
    const no = str(req.params.no);
    const key = str(req.body.key);
    if (!ORDER_NO_RE.test(no) || !ACCESS_KEY_RE.test(key)) throw new HttpError(404, '订单不存在');
    const order = await orders.submitToken(no, key, req.body.token);
    res.json(orders.publicView(order));
  }),
);

// ---------- 支付回调 ----------
for (const name of ['alipay', 'wechat'] as const) {
  router.post(
    `/notify/${name}`,
    // 回调每次都要做 RSA 验签，限制单 IP 频率防止被刷 CPU（正常回调量远低于此）
    rateLimit(`notify-${name}`, [{ scope: 'ip', max: 300, windowMs: MIN }]),
    // 支付宝回调是表单格式；只在这里启用表单解析
    express.urlencoded({ extended: false, limit: '64kb' }),
    wrap(async (req, res) => {
      if (!payments.isEnabled(name)) {
        res.status(404).end();
        return;
      }
      const provider = payments.get(name);
      if (!provider.parseNotify || !provider.ackSuccess || !provider.ackFail) {
        res.status(404).end();
        return;
      }
      try {
        const n = provider.parseNotify(req as unknown as NotifyRequest);
        // 必须等入库完成再应答成功：入库失败时返回失败，支付平台会重发通知
        if (n.paid) await orders.markPaid(n.orderNo, n, 'notify');
        provider.ackSuccess(res);
      } catch (e) {
        console.error(`[notify:${name}]`, (e as Error).message);
        provider.ackFail(res);
      }
    }),
  );
}

export default router;

// ---------- 模拟支付页（仅 mock 渠道启用时挂载） ----------
export function mockPayRouter(): express.Router {
  const r = express.Router();
  // 第三重保险：模拟支付只接受本机发起的请求。即使被误部署到公网，外部访问者也无法免费标记订单已支付
  r.use('/mock-pay', (req, res, next) => {
    const ip = (req.ip ?? '').replace(/^::ffff:/, '');
    if (ip === '127.0.0.1' || ip === '::1') return next();
    res.status(403).send('模拟支付仅限本机访问');
  });
  r.get('/mock-pay/:no', wrap(async (req, res) => {
    const o = await orders.orderByNo(str(req.params.no));
    if (!o) {
      res.status(404).send('订单不存在');
      return;
    }
    res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <title>模拟支付</title><body style="font-family:sans-serif;padding:24px;max-width:420px;margin:auto">
      <h2>模拟支付</h2><p>订单：${o.order_no}</p><p>金额：¥${(o.amount_cents / 100).toFixed(2)}</p>
      <form method="post"><button style="padding:12px 24px;font-size:16px">确认支付</button></form></body>`);
  }));
  r.post('/mock-pay/:no', wrap(async (req, res) => {
    const o = await orders.orderByNo(str(req.params.no));
    if (!o) {
      res.status(404).send('订单不存在');
      return;
    }
    mockPay.markPaid(o.order_no, o.amount_cents);
    await orders.markPaid(o.order_no, { tradeNo: `MOCK-${o.order_no}`, amountCents: o.amount_cents }, 'mock');
    res.type('html').send('<meta charset="utf-8"><body style="font-family:sans-serif;padding:24px">支付成功，请返回订单页面填写 Token。</body>');
  }));
  return r;
}
