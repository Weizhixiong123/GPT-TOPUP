import { get, all, run, tx, now, type Db } from '../db.ts';
import config from '../config.ts';
import * as payments from '../payments/index.ts';
import upstream from '../upstream/index.ts';
import { encrypt, mask, randomId, safeEqual, orderNo as genOrderNo } from '../crypto.ts';
import { HttpError, type Order, type OrderStatus, type PayChannel, type Plan } from '../types.ts';

const MAX_TOKEN_ATTEMPTS = 5;

export const orderById = (id: number, db: Pick<Db, 'get'> = { get }): Promise<Order | undefined> =>
  db.get<Order>('SELECT * FROM orders WHERE id = $1', id);
export const orderByNo = (no: string): Promise<Order | undefined> => get<Order>('SELECT * FROM orders WHERE order_no = $1', no);

/** 读取必然存在的订单 */
export async function mustOrder(id: number): Promise<Order> {
  const o = await orderById(id);
  if (!o) throw new Error(`订单 #${id} 不存在`);
  return o;
}

export async function log(orderId: number, event: string, detail: string | object = '', db: Pick<Db, 'run'> = { run }): Promise<void> {
  await db.run(
    'INSERT INTO order_logs (order_id, event, detail, created_at) VALUES ($1, $2, $3, $4)',
    orderId,
    event,
    typeof detail === 'string' ? detail : JSON.stringify(detail),
    now(),
  );
}

/**
 * 可售库存 = 可用卡密 - 已支付但还没分到卡密的订单（SQL 表达式，p 为 plans 表别名）。
 * 未支付订单不占库存：否则有人批量下单不付款，就能让套餐长时间显示缺货。
 * 代价是库存极少时可能出现「付款的人比卡多」，多出的订单会停在 QUEUED 等补货，由 worker 自动继续。
 */
export const SELLABLE_SQL = `(
  (SELECT COUNT(*) FROM card_keys c WHERE c.plan_id = p.id AND c.status = 'AVAILABLE')
  - (SELECT COUNT(*) FROM orders o WHERE o.plan_id = p.id AND o.card_id IS NULL AND o.status IN ('PAID', 'QUEUED'))
)`;

export async function sellableStock(planId: number, db: Pick<Db, 'get'> = { get }): Promise<number> {
  return (await db.get<{ n: number }>(`SELECT ${SELLABLE_SQL} AS n FROM plans p WHERE p.id = $1`, planId))?.n ?? 0;
}

/** 人工服务套餐：在 MANUAL_PLAN_IDS 里，或者站点没有接入任何在线支付（此时全部套餐都只能联系客服购买） */
const isManualPlan = (planId: number): boolean => payments.enabled.length === 0 || config.manualPlanIds.includes(planId);

export async function listPlans() {
  const rows = await all<Pick<Plan, 'id' | 'name' | 'description' | 'price_cents'> & { sellable: number }>(
    `SELECT p.id, p.name, p.description, p.price_cents, ${SELLABLE_SQL} AS sellable
     FROM plans p WHERE p.active = 1 ORDER BY p.sort, p.id`,
  );
  // manual：人工服务套餐，前台不走自助下单，改为引导用户联系客服
  return rows.map(({ sellable, ...p }) => ({ ...p, in_stock: sellable > 0, manual: isManualPlan(p.id) }));
}

/**
 * @param clientIp 限流用的客户端标识（IPv6 已按 /64 归并），用于「同一 IP 未支付订单上限」
 * @param payerIp  付款用户的原始 IP，传给支付平台（易支付下单必填）
 */
export async function createOrder(planId: number, channel: string, clientIp = '', mobile = false, payerIp = ''): Promise<Order> {
  if (!Number.isInteger(planId)) throw new HttpError(404, '套餐不存在');
  const plan = await get<Plan>('SELECT * FROM plans WHERE id = $1 AND active = 1', planId);
  if (!plan) throw new HttpError(404, '套餐不存在');
  // 服务端也要拦：只改前台按钮的话，绕过页面直接调接口仍能下单付款
  if (isManualPlan(plan.id)) throw new HttpError(400, '该套餐由专人充值，请联系客服购买');
  const provider = payments.get(channel);

  const t = now();
  const order = await tx(async (db) => {
    if ((await sellableStock(plan.id, db)) <= 0) throw new HttpError(409, '该套餐暂时缺货，请稍后再试');
    if (clientIp) {
      const pending =
        (await db.get<{ c: number }>(
          "SELECT COUNT(*) c FROM orders WHERE client_ip = $1 AND status = 'PENDING_PAYMENT' AND expire_at > $2",
          clientIp,
          t,
        ))?.c ?? 0;
      if (pending >= config.antiAbuse.maxPendingPerIp) {
        throw new HttpError(429, '你有多笔未支付的订单，请先完成支付或等待订单过期后再下单');
      }
    }
    const created = await db.get<Order>(
      `INSERT INTO orders (order_no, access_key, plan_id, plan_name, amount_cents, pay_channel, status,
         next_run_at, created_at, expire_at, updated_at, client_ip)
       VALUES ($1, $2, $3, $4, $5, $6, 'PENDING_PAYMENT', $7, $8, $9, $10, $11)
       RETURNING *`,
      genOrderNo(),
      randomId(),
      plan.id,
      plan.name,
      plan.price_cents,
      provider.name,
      t + 30e3,
      t,
      t + config.orderExpireMinutes * 60e3,
      t,
      clientIp,
    );
    if (!created) throw new Error('创建订单失败');
    await log(created.id, 'CREATED', { channel, amount: created.amount_cents }, db);
    return created;
  });

  try {
    const { qr } = await provider.createQr({
      orderNo: order.order_no,
      amountCents: order.amount_cents,
      subject: plan.name,
      expireAt: order.expire_at,
      mobile,
      clientIp: payerIp,
    });
    await run('UPDATE orders SET pay_qr = $1, updated_at = $2 WHERE id = $3', qr, now(), order.id);
    return { ...order, pay_qr: qr };
  } catch (e) {
    await run("UPDATE orders SET status = 'EXPIRED', message = $1, updated_at = $2 WHERE id = $3", '创建支付失败', now(), order.id);
    await log(order.id, 'PAY_CREATE_FAILED', (e as Error).message);
    throw new HttpError(502, '创建支付订单失败，请稍后重试');
  }
}

export type PaySource = 'notify' | 'query' | 'worker' | 'mock';

/** 支付成功（回调/主动查询共用），幂等 */
export async function markPaid(orderNo: string, pay: { tradeNo?: string; amountCents?: number }, source: PaySource): Promise<boolean> {
  const order = await orderByNo(orderNo);
  if (!order) throw new Error(`订单不存在 ${orderNo}`);
  if (pay.amountCents !== order.amount_cents) {
    await log(order.id, 'PAY_AMOUNT_MISMATCH', { source, amountCents: pay.amountCents, expected: order.amount_cents });
    throw new Error(`金额不一致 ${orderNo}`);
  }
  // 过期或取消之后才到账的也接受（钱已经收了），由用户继续填写 Token。
  // next_run_at 设为现在：让 worker 立刻为这笔订单分配卡密并向上游核对
  const r = await run(
    `UPDATE orders SET status = 'PAID', pay_trade_no = $1, paid_at = $2, next_run_at = $2, message = '', finished_at = NULL, updated_at = $2
     WHERE id = $3 AND status IN ('PENDING_PAYMENT', 'EXPIRED', 'CANCELLED')`,
    pay.tradeNo || '',
    now(),
    order.id,
  );
  if (r.changes) await log(order.id, 'PAID', { source, tradeNo: pay.tradeNo });
  return r.changes > 0;
}

const lastPayQuery = new Map<number, number>();
/** 用户轮询时主动查一次支付状态（防回调丢失），每单 5 秒节流 */
export async function syncPayment(order: Order): Promise<Order> {
  if (order.status !== 'PENDING_PAYMENT') return order;
  const last = lastPayQuery.get(order.id) ?? 0;
  if (now() - last < 5000) return order;
  lastPayQuery.set(order.id, now());
  try {
    const r = await payments.get(order.pay_channel).query(order.order_no);
    if (r.paid && (await markPaid(order.order_no, r, 'query'))) return mustOrder(order.id);
  } catch (e) {
    console.warn(`[pay-query] ${order.order_no}: ${(e as Error).message}`);
  }
  return order;
}
// 节流表定期清理，防止内存增长
setInterval(() => {
  const t = now();
  for (const [id, at] of lastPayQuery) if (t - at > 60e3) lastPayQuery.delete(id);
}, 5 * 60e3).unref();

/**
 * 用户取消一笔还没付款的订单。
 * 先问支付平台到底付了没有：付了就不取消，直接按已支付处理；没付才关闭交易并标记取消。
 */
export async function cancelOrder(orderNo: string, accessKey: string): Promise<Order> {
  const order = await getForUser(orderNo, accessKey);
  if (order.status !== 'PENDING_PAYMENT') throw new HttpError(409, '只有未支付的订单可以取消');

  const provider = payments.isEnabled(order.pay_channel) ? payments.get(order.pay_channel) : undefined;
  if (provider) {
    try {
      const r = await provider.query(order.order_no);
      if (r.paid) {
        await markPaid(order.order_no, r, 'query');
        throw new HttpError(409, '这笔订单已经支付成功，无法取消');
      }
    } catch (e) {
      if (e instanceof HttpError) throw e;
      // 查不通时不拦着用户取消：万一其实付了，之后的到账通知会把订单恢复为已支付
      console.warn(`[cancel] 支付查询失败 ${order.order_no}: ${(e as Error).message}`);
    }
    try {
      await provider.close?.(order.order_no);
    } catch (e) {
      // 关不掉也继续取消，原因记到订单日志里
      await log(order.id, 'PAY_CLOSE_FAILED', (e as Error).message);
    }
  }

  const t = now();
  const r = await run(
    "UPDATE orders SET status = 'CANCELLED', message = '订单已取消', next_run_at = NULL, finished_at = $1, updated_at = $1 WHERE id = $2 AND status = 'PENDING_PAYMENT'",
    t,
    order.id,
  );
  // 没改到：就在这一瞬间到账或过期了，把最新状态返回给页面
  if (r.changes) await log(order.id, 'CANCELLED', '用户取消');
  return mustOrder(order.id);
}

export async function getForUser(orderNo: string, accessKey: string): Promise<Order> {
  const order = await orderByNo(orderNo);
  // 用恒定时间比较，避免通过响应耗时逐位猜出访问密钥
  if (!order || !safeEqual(order.access_key, accessKey)) throw new HttpError(404, '订单不存在');
  return order;
}

/** 返回给用户的订单视图（不含卡密、Token 密文、IP 等敏感字段） */
export interface PublicOrderView {
  order_no: string;
  plan_name: string;
  amount_cents: number;
  pay_channel: PayChannel;
  /** 二维码内容；走收银台链接的订单为 null */
  pay_qr: string | null;
  pay_qr_image?: string;
  /** 收银台链接：有值时页面不自己画二维码 */
  pay_link: string | null;
  status: OrderStatus;
  message: string;
  token_mask: string | null;
  /** 充值账号邮箱（掩码） */
  account_email: string;
  can_submit_token: boolean;
  /** 用户能否取消这笔订单（只有未支付的可以） */
  can_cancel: boolean;
  /** 提交时是否必须是 session 整页 JSON（由上游决定），前端据此校验粘贴内容 */
  need_session: boolean;
  created_at: number;
  expire_at: number;
  paid_at: number | null;
  finished_at: number | null;
}

export function publicView(o: Order): PublicOrderView {
  // 过了支付期限就不再给二维码或付款链接（此后 worker 还会查单一小段时间，确认最后一刻的付款）
  const payable = o.status === 'PENDING_PAYMENT' && now() < o.expire_at ? o.pay_qr : null;
  const isLink = !!payable && payments.isEnabled(o.pay_channel) && payments.get(o.pay_channel).isLink?.(payable) === true;
  return {
    order_no: o.order_no,
    plan_name: o.plan_name,
    amount_cents: o.amount_cents,
    pay_channel: o.pay_channel,
    pay_qr: isLink ? null : payable,
    pay_link: isLink ? payable : null,
    status: o.status,
    message: o.message,
    token_mask: o.token_mask,
    account_email: maskEmail(o.account_email),
    can_submit_token:
      (o.status === 'PAID' || (o.status === 'FAILED' && !o.card_id)) && o.token_attempts < MAX_TOKEN_ATTEMPTS,
    can_cancel: o.status === 'PENDING_PAYMENT',
    need_session: upstream.needsSession === true,
    created_at: o.created_at,
    expire_at: o.expire_at,
    paid_at: o.paid_at,
    finished_at: o.finished_at,
  };
}

/**
 * 从 ChatGPT accessToken（JWT）中解析账号邮箱，仅用于展示和客服对账，不做签名校验。
 * 邮箱位于 payload 的 "https://api.openai.com/profile".email；解析失败返回空串。
 */
export function extractEmail(token: string): string {
  try {
    const payload = token.split('.')[1];
    if (!payload) return '';
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    const profile = json['https://api.openai.com/profile'] as { email?: unknown } | undefined;
    const email = profile?.email ?? json.email;
    return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email.slice(0, 254) : '';
  } catch {
    return '';
  }
}

/** 给用户看的邮箱掩码：ab***@gmail.com */
export function maskEmail(email: string): string {
  const [name = '', domain = ''] = email.split('@');
  if (!domain) return '';
  return `${name.slice(0, Math.min(2, name.length))}***@${domain}`;
}

/** 用户提交的登录凭证 */
interface Credential {
  /** 交给上游的原文：accessToken，或 session JSON 整段 */
  text: string;
  /** 用于生成掩码的那个 Token */
  display: string;
  email: string;
}

/**
 * 校验用户提交的内容。支持两种形式：
 *   - chatgpt.com/api/auth/session 的整页 JSON（上游需要 sessionToken 时必须是这种）
 *   - 单独的 accessToken（仅当上游不需要 sessionToken 时接受）
 */
function parseCredential(raw: unknown): Credential {
  const text = String(raw ?? '').trim();
  if (text.length < 20 || text.length > 32768) throw new HttpError(400, 'Token 格式不正确');

  if (text.startsWith('{')) {
    let json: { accessToken?: unknown; sessionToken?: unknown; user?: { email?: unknown } };
    try {
      json = JSON.parse(text);
    } catch {
      throw new HttpError(400, '内容不完整，请重新全选复制');
    }
    // 不可见的控制字符 / 零宽字符会让上游判定格式错误，提前拦下
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‍⁠﻿]/.test(text)) {
      throw new HttpError(400, '内容里含有异常字符，请重新全选复制');
    }
    const access = typeof json.accessToken === 'string' ? json.accessToken : '';
    const session = typeof json.sessionToken === 'string' ? json.sessionToken : '';
    if (upstream.needsSession ? !session.startsWith('eyJ') : !access) {
      throw new HttpError(400, '没有找到登录信息，请先登录 chatgpt.com 再重新复制');
    }
    // 上游只要 accessToken 时不保存整段 JSON（里面的 sessionToken 权限更大，用不到就不留）
    if (!upstream.needsSession) return { text: validateToken(access), display: access, email: extractEmail(access) };
    const userEmail = typeof json.user?.email === 'string' ? json.user.email : '';
    const email = extractEmail(access) || (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(userEmail) ? userEmail.slice(0, 254) : '');
    return { text, display: access || session, email };
  }

  if (upstream.needsSession) throw new HttpError(400, '请复制页面的全部内容（按 Ctrl+A 全选），不要只复制其中一段');
  const token = validateToken(text);
  return { text: token, display: token, email: extractEmail(token) };
}

function validateToken(token: string): string {
  if (token.length < 20 || token.length > 8192) throw new HttpError(400, 'Token 格式不正确');
  if (/\s/.test(token)) throw new HttpError(400, 'Token 中不能包含空白字符');
  return token;
}

/** 用户提交 Token：PAID（或 Token 原因导致的 FAILED）→ QUEUED，交给 worker 分配卡密并兑换 */
export async function submitToken(orderNo: string, accessKey: string, rawToken: unknown): Promise<Order> {
  const order = await getForUser(orderNo, accessKey);
  const { text, display, email } = parseCredential(rawToken);
  const t = now();
  const updated = await get<Order>(
    `UPDATE orders SET status = 'QUEUED', token_enc = $1, token_mask = $2, account_email = $3, token_at = $4,
       token_attempts = token_attempts + 1, submit_attempts = 0, card_switches = 0, query_attempts = 0, upstream_task_id = NULL,
       message = '已提交，正在处理', next_run_at = $4, finished_at = NULL, updated_at = $4
     WHERE id = $5 AND token_attempts < $6 AND (status = 'PAID' OR (status = 'FAILED' AND card_id IS NULL))
     RETURNING *`,
    encrypt(text),
    mask(display),
    email,
    t,
    order.id,
    MAX_TOKEN_ATTEMPTS,
  );
  if (!updated) throw new HttpError(409, '当前订单状态不允许提交 Token');
  await log(order.id, 'TOKEN_SUBMITTED', email ? `${mask(display)} (${email})` : mask(display));
  return updated;
}
