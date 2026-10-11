import express, { type Request, type Response, type NextFunction } from 'express';
import config from '../config.ts';
import { get, all, run, tx, now } from '../db.ts';
import { safeEqual } from '../crypto.ts';
import { failureGuard } from '../ratelimit.ts';
import { log, SELLABLE_SQL } from '../services/orders.ts';
import * as worker from '../worker.ts';
import upstream from '../upstream/index.ts';
import { HttpError, type CardStatus, type Order, type OrderStatus, type Plan } from '../types.ts';

const router = express.Router();
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
/** Express 4 不会捕获 async 处理函数的异常，统一包一层交给错误处理中间件 */
const h =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };
function idParam(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(404, '记录不存在');
  return id;
}

// 同一 IP 15 分钟内密码错误 10 次即锁定，防暴力破解
const loginGuard = failureGuard('admin-login', 10, 15 * 60e3);

router.use((req, res, next) => {
  const ip = req.ip ?? '';
  const wait = loginGuard.blocked(ip);
  if (wait) {
    res.set('Retry-After', String(wait));
    res.status(429).json({ error: `密码错误次数过多，请 ${Math.ceil(wait / 60)} 分钟后再试` });
    return;
  }
  const [scheme, value] = (req.get('Authorization') ?? '').split(' ');
  if (scheme === 'Basic' && value) {
    const [u = '', ...p] = Buffer.from(value, 'base64').toString().split(':');
    if (safeEqual(u, config.adminUser) && safeEqual(p.join(':'), config.adminPassword)) return next();
  }
  loginGuard.fail(ip);
  res.status(401).json({ error: '未登录或密码错误' });
});

// ---------- 概览 ----------
router.get(
  '/stats',
  h(async (_req, res) => {
    // 按北京时间算「今天」，与服务器所在时区无关
    const TZ = 8 * 3600e3;
    const startOfToday = Math.floor((now() + TZ) / 86400e3) * 86400e3 - TZ;
    const [byStatus, paid24h, success] = await Promise.all([
      all<{ status: OrderStatus; c: number }>('SELECT status, COUNT(*) c FROM orders GROUP BY status'),
      get<{ c: number; s: number }>(
        "SELECT COUNT(*) c, COALESCE(SUM(amount_cents), 0)::bigint s FROM orders WHERE paid_at >= $1 AND status <> 'REFUNDED'",
        now() - 86400e3,
      ),
      get<{ c: number }>("SELECT COUNT(*) c FROM orders WHERE status = 'SUCCESS' AND finished_at >= $1", startOfToday),
    ]);
    res.json({ byStatus, paid24h, successToday: success?.c ?? 0 });
  }),
);

// ---------- 套餐 ----------
router.get(
  '/plans',
  h(async (_req, res) => {
    const [plans, counts] = await Promise.all([
      all<Plan & { sellable: number }>(`SELECT p.*, ${SELLABLE_SQL} AS sellable FROM plans p ORDER BY p.sort, p.id`),
      all<{ plan_id: number; status: CardStatus; c: number }>('SELECT plan_id, status, COUNT(*) c FROM card_keys GROUP BY plan_id, status'),
    ]);
    res.json(
      plans.map((p) => ({
        ...p,
        cards: Object.fromEntries(counts.filter((c) => c.plan_id === p.id).map((c) => [c.status, c.c])),
      })),
    );
  }),
);

router.post(
  '/plans',
  h(async (req, res) => {
    const { id, name, description = '', price_cents, sort = 0, active = 1 } = req.body as {
      id?: number;
      name?: string;
      description?: string;
      price_cents?: number;
      sort?: number;
      active?: boolean | number;
    };
    if (!name || !Number.isInteger(price_cents) || !price_cents || price_cents <= 0) {
      throw new HttpError(400, '名称和价格（分，正整数）必填');
    }
    if (id) {
      const r = await run(
        'UPDATE plans SET name = $1, description = $2, price_cents = $3, sort = $4, active = $5 WHERE id = $6',
        name, description, price_cents, Number(sort) || 0, active ? 1 : 0, Number(id),
      );
      if (!r.changes) throw new HttpError(404, '套餐不存在');
    } else {
      await run(
        'INSERT INTO plans (name, description, price_cents, sort, active, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
        name, description, price_cents, Number(sort) || 0, active ? 1 : 0, now(),
      );
    }
    res.json({ ok: true });
  }),
);

// ---------- 卡密 ----------
router.post(
  '/cards/import',
  h(async (req, res) => {
    const planId = Number(req.body.plan_id);
    if (!Number.isInteger(planId) || !(await get('SELECT 1 FROM plans WHERE id = $1', planId))) throw new HttpError(400, '套餐不存在');
    const codes = [...new Set(String(req.body.codes ?? '').split(/[\r\n,]+/).map((s) => s.trim()).filter(Boolean))];
    if (codes.length > 5000) throw new HttpError(400, '单次最多导入 5000 个卡密');

    // 上游支持查询卡密状态时，导入前先逐张核对：只有「未使用」的才入库，其余拦下并返回原因
    let accepted = codes;
    const rejected: { code: string; reason: string }[] = [];
    if (upstream.checkCards && codes.length) {
      // 上游每次只能查 100 张，张数太多会超过单个请求的处理时限
      if (codes.length > 1000) throw new HttpError(400, '需要向上游核对卡密状态，单次最多导入 1000 个，请分批导入');
      let checked: Awaited<ReturnType<NonNullable<typeof upstream.checkCards>>>;
      try {
        checked = await upstream.checkCards(codes);
      } catch (e) {
        // 查不了就不导入：宁可让管理员重试，也不把没核对过的卡放进库存
        throw new HttpError(502, `向上游核对卡密失败，本次未导入任何卡密：${(e as Error).message}`);
      }
      accepted = [];
      for (const code of codes) {
        const c = checked.get(code);
        if (c?.cardStatus === 'UNUSED') accepted.push(code);
        else rejected.push({ code, reason: c?.detail ?? '上游未返回该卡密' });
      }
    }

    // 一条语句批量插入，重复卡密由唯一索引跳过（卡密按换行拼接传入，已保证不含换行）
    const r = accepted.length
      ? await run(
          `INSERT INTO card_keys (plan_id, code, created_at)
           SELECT $1::bigint, code, $2::bigint FROM unnest(string_to_array($3::text, E'\\n')) AS code
           ON CONFLICT (code) DO NOTHING`,
          planId,
          now(),
          accepted.join('\n'),
        )
      : { changes: 0 };
    res.json({ total: codes.length, added: r.changes, duplicated: accepted.length - r.changes, rejected });
  }),
);

router.get(
  '/cards',
  h(async (req, res) => {
    const planId = str(req.query.plan_id);
    const status = str(req.query.status);
    const q = str(req.query.q);
    const where: string[] = [];
    const args: (string | number)[] = [];
    const p = (v: string | number) => (args.push(v), `$${args.length}`);
    if (planId) where.push(`c.plan_id = ${p(Number(planId))}`);
    if (status) where.push(`c.status = ${p(status)}`);
    if (q) where.push(`c.code ILIKE ${p(`%${q}%`)}`);
    const rows = await all(
      `SELECT c.*, o.order_no FROM card_keys c LEFT JOIN orders o ON o.id = c.order_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY c.id DESC LIMIT 200`,
      ...args,
    );
    res.json(rows);
  }),
);

router.post(
  '/cards/:id/void',
  h(async (req, res) => {
    const r = await run("UPDATE card_keys SET status = 'INVALID', note = $1 WHERE id = $2 AND status = 'AVAILABLE'", '后台作废', idParam(req));
    if (!r.changes) throw new HttpError(409, '只能作废未使用的卡密');
    res.json({ ok: true });
  }),
);

// ---------- 订单 ----------
const ORDER_COLS = `o.id, o.order_no, o.plan_name, o.amount_cents, o.pay_channel, o.pay_trade_no, o.status, o.message,
  o.token_mask, o.account_email, o.card_id, c.code AS card_code, o.upstream_task_id, o.submit_attempts, o.query_attempts,
  o.created_at, o.paid_at, o.finished_at, o.updated_at`;

router.get(
  '/orders',
  h(async (req, res) => {
    const status = str(req.query.status);
    const q = str(req.query.q);
    const where: string[] = [];
    const args: string[] = [];
    const p = (v: string) => (args.push(v), `$${args.length}`);
    // 支持逗号分隔的多个状态，如 QUEUED,REDEEMING
    const statuses = status.split(',').filter(Boolean);
    if (statuses.length) where.push(`o.status IN (${statuses.map(p).join(', ')})`);
    if (q) {
      const like = p(`%${q}%`);
      where.push(`(o.order_no ILIKE ${like} OR o.pay_trade_no ILIKE ${like} OR c.code ILIKE ${like} OR o.account_email ILIKE ${like})`);
    }
    const rows = await all(
      `SELECT ${ORDER_COLS} FROM orders o LEFT JOIN card_keys c ON c.id = o.card_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY o.id DESC LIMIT 200`,
      ...args,
    );
    res.json(rows);
  }),
);

router.get(
  '/orders/:id',
  h(async (req, res) => {
    const id = idParam(req);
    const [order, logs] = await Promise.all([
      get(`SELECT ${ORDER_COLS} FROM orders o LEFT JOIN card_keys c ON c.id = o.card_id WHERE o.id = $1`, id),
      all('SELECT event, detail, created_at FROM order_logs WHERE order_id = $1 ORDER BY id', id),
    ]);
    if (!order) throw new HttpError(404, '订单不存在');
    res.json({ order, logs });
  }),
);

/**
 * 人工处理（主要针对 MANUAL_REVIEW）：
 *   requery        重新开始查询上游结果（有 task id 时）
 *   resubmit       用当前绑定卡密重新提交上游
 *   mark_success   人工确认成功，卡密标记已用
 *   mark_failed    人工确认失败；release_card=true 卡密退回库存，否则作废
 *   mark_refunded  已线下/商户后台退款（需先无绑定卡密）
 */
type AdminAction = 'requery' | 'resubmit' | 'mark_success' | 'mark_failed' | 'mark_refunded';

router.post(
  '/orders/:id/action',
  h(async (req, res) => {
    const id = idParam(req);
    const { action, release_card, remark = '' } = req.body as { action: AdminAction; release_card?: boolean; remark?: string };
    const t = now();

    await tx(async (db) => {
      // 行锁：防止与 worker 同时修改同一订单
      const order = await db.get<Order>('SELECT * FROM orders WHERE id = $1 FOR UPDATE', id);
      if (!order) throw new HttpError(404, '订单不存在');
      const need = (...states: OrderStatus[]) => {
        if (!states.includes(order.status)) throw new HttpError(409, `当前状态 ${order.status} 不支持该操作`);
      };

      switch (action) {
        case 'requery':
          need('MANUAL_REVIEW');
          if (!order.upstream_task_id) throw new HttpError(409, '没有上游任务号');
          await db.run("UPDATE orders SET status = 'REDEEMING', query_attempts = 0, message = '充值处理中', next_run_at = $1, updated_at = $1 WHERE id = $2", t, id);
          break;
        case 'resubmit':
          need('MANUAL_REVIEW');
          if (!order.token_enc) throw new HttpError(409, 'Token 已清除，无法重新提交');
          await db.run("UPDATE orders SET status = 'QUEUED', upstream_task_id = NULL, message = '已提交，正在处理', next_run_at = $1, updated_at = $1 WHERE id = $2", t, id);
          break;
        case 'mark_success':
          need('MANUAL_REVIEW', 'FAILED', 'REDEEMING', 'QUEUED');
          if (!order.card_id) throw new HttpError(409, '订单未绑定卡密');
          await db.run("UPDATE card_keys SET status = 'USED', used_at = $1 WHERE id = $2", t, order.card_id);
          await db.run("UPDATE orders SET status = 'SUCCESS', message = '充值成功', token_enc = NULL, next_run_at = NULL, finished_at = $1, updated_at = $1 WHERE id = $2", t, id);
          break;
        case 'mark_failed':
          need('MANUAL_REVIEW', 'REDEEMING', 'QUEUED');
          if (order.card_id) {
            if (release_card) await db.run("UPDATE card_keys SET status = 'AVAILABLE', order_id = NULL, locked_at = NULL WHERE id = $1", order.card_id);
            else await db.run("UPDATE card_keys SET status = 'INVALID', note = $1 WHERE id = $2", `人工作废 订单${order.order_no}`, order.card_id);
          }
          await db.run(
            "UPDATE orders SET status = 'FAILED', card_id = NULL, upstream_task_id = NULL, message = $1, token_enc = NULL, next_run_at = NULL, finished_at = $2, updated_at = $2 WHERE id = $3",
            `充值失败${remark ? `：${remark}` : ''}，如需退款请联系客服`, t, id,
          );
          break;
        case 'mark_refunded':
          need('PAID', 'FAILED');
          // PAID 订单绑定的是付款后预分配、还没提交过上游的卡密，退款时直接放回库存
          if (order.card_id) {
            if (order.status !== 'PAID') throw new HttpError(409, '订单仍绑定卡密，请先处理卡密');
            await db.run("UPDATE card_keys SET status = 'AVAILABLE', order_id = NULL, locked_at = NULL WHERE id = $1", order.card_id);
          }
          await db.run("UPDATE orders SET status = 'REFUNDED', card_id = NULL, message = '已退款', token_enc = NULL, next_run_at = NULL, finished_at = $1, updated_at = $1 WHERE id = $2", t, id);
          break;
        default:
          throw new HttpError(400, '未知操作');
      }
      await log(id, `ADMIN_${String(action).toUpperCase()}`, remark, db);
    });

    if (action === 'requery' || action === 'resubmit') void worker.tick();
    res.json({ ok: true });
  }),
);

export default router;
