import { get, all, run, tx, now, type Db } from './db.ts';
import config from './config.ts';
import * as payments from './payments/index.ts';
import upstream from './upstream/index.ts';
import { decrypt } from './crypto.ts';
import { log, markPaid } from './services/orders.ts';
import { assertNever, type CardKey, type CardStatus, type Order, type OrderStatus, type QueryResult, type SubmitResult } from './types.ts';

const LEASE_MS = 120e3;
const MAX_CARD_SWITCHES = 3;
const BATCH = 20;

type Card = Pick<CardKey, 'id' | 'code'>;
/** 允许 worker 修改的订单字段（id / order_no / 金额等不可改） */
type OrderUpdate = Partial<Omit<Order, 'id' | 'order_no' | 'access_key' | 'plan_id' | 'amount_cents' | 'created_at'>>;
type Rejection = Extract<SubmitResult, { type: 'REJECTED' }> | Extract<QueryResult, { type: 'FAILED' }>;

/**
 * 乐观租约抢占：把 next_run_at 推到未来，只有抢到的 worker 处理该订单，
 * 防止同一订单被重复提交上游（多实例部署也安全）。
 */
async function claim(order: Order): Promise<Order | undefined> {
  const t = now();
  const lease = t + LEASE_MS;
  const r = await run(
    'UPDATE orders SET next_run_at = $1, updated_at = $2 WHERE id = $3 AND status = $4 AND next_run_at IS NOT DISTINCT FROM $5',
    lease,
    t,
    order.id,
    order.status,
    order.next_run_at,
  );
  return r.changes > 0 ? { ...order, next_run_at: lease } : undefined;
}

/** 订单在 worker 处理期间被别处改动（如后台人工操作），本次处理结果作废 */
class LeaseLostError extends Error {}

/**
 * 只在仍持有租约时写入：order 必须是 claim 返回的对象（status / next_run_at 与抢占时一致）。
 * worker 调用上游期间不持有行锁，后台可能已把订单改成别的状态并退回卡密，
 * 此时绝不能再把订单写回处理中，否则同一张卡会被分给两个订单。
 */
async function update(order: Order, fields: OrderUpdate, db: Pick<Db, 'run'> = { run }): Promise<void> {
  const keys = Object.keys(fields) as (keyof OrderUpdate)[];
  const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
  const n = keys.length;
  const r = await db.run(
    `UPDATE orders SET ${sets}, updated_at = $${n + 1}
     WHERE id = $${n + 2} AND status = $${n + 3} AND next_run_at IS NOT DISTINCT FROM $${n + 4}`,
    ...keys.map((k) => fields[k] as string | number | null),
    now(),
    order.id,
    order.status,
    order.next_run_at,
  );
  if (!r.changes) throw new LeaseLostError(`订单 ${order.order_no} 已被其他操作修改，放弃本次处理结果`);
}

async function setCard(db: Db, cardId: number | null, status: CardStatus, note = ''): Promise<void> {
  if (cardId === null) throw new Error('订单未绑定卡密');
  if (status === 'AVAILABLE') {
    await db.run("UPDATE card_keys SET status = 'AVAILABLE', order_id = NULL, locked_at = NULL WHERE id = $1", cardId);
  } else if (status === 'USED') {
    await db.run("UPDATE card_keys SET status = 'USED', used_at = $1 WHERE id = $2", now(), cardId);
  } else {
    await db.run('UPDATE card_keys SET status = $1, note = $2 WHERE id = $3', status, note, cardId);
  }
}

// ---------- 终态处理 ----------

export async function finishSuccess(order: Order): Promise<void> {
  await tx(async (db) => {
    // 先改订单（带租约校验）再动卡密：校验失败时整个事务回滚，卡密不受影响
    await update(order, { status: 'SUCCESS', message: '充值成功', token_enc: null, next_run_at: null, finished_at: now() }, db);
    await setCard(db, order.card_id, 'USED');
    await log(order.id, 'SUCCESS', '', db);
  });
}

/** 卡密未被消耗的失败（通常是 Token 问题）：释放卡密，用户可重新提交 Token */
async function finishFailedReleaseCard(order: Order, reason: string): Promise<void> {
  await tx(async (db) => {
    await update(
      order,
      {
        status: 'FAILED',
        card_id: null,
        upstream_task_id: null,
        message: `充值失败：${reason}`,
        token_enc: null,
        next_run_at: null,
        finished_at: now(),
      },
      db,
    );
    await setCard(db, order.card_id, 'AVAILABLE');
    await log(order.id, 'FAILED', reason, db);
  });
}

/**
 * 卡密本身无效：作废该卡，重新排队换卡。
 * count=false 用于提交前核对出的坏卡：还没拿去提交过，不计入「连续换卡次数」上限。
 */
async function switchCard(order: Order, reason: string, count = true): Promise<void> {
  await tx(async (db) => {
    await update(
      order,
      {
        status: 'QUEUED',
        card_id: null,
        upstream_task_id: null,
        card_switches: order.card_switches + (count ? 1 : 0),
        submit_attempts: 0,
        query_attempts: 0,
        next_run_at: now(),
      },
      db,
    );
    await setCard(db, order.card_id, 'INVALID', `订单 ${order.order_no}: ${reason}`);
    await log(order.id, 'CARD_INVALID', reason, db);
  });
}

/** 结果不确定：卡密保持锁定，转人工 */
async function toManual(order: Order, reason: string): Promise<void> {
  await update(order, { status: 'MANUAL_REVIEW', message: '已转人工核实，请联系客服并提供订单号', next_run_at: null });
  await log(order.id, 'MANUAL_REVIEW', reason);
}

// ---------- 各状态处理 ----------

/** 订单过期后继续查单的宽限期：用户在最后几秒付款时，支付平台的结果可能稍晚才能查到 */
const PAY_GRACE_MS = 120e3;

async function processPendingPayment(order: Order): Promise<void> {
  if (!(await claim(order))) return;
  let paid = false;
  try {
    const r = await payments.get(order.pay_channel).query(order.order_no);
    if (r.paid) paid = await markPaid(order.order_no, r, 'worker');
  } catch (e) {
    console.warn(`[worker] 支付查询失败 ${order.order_no}: ${(e as Error).message}`);
  }
  if (paid) return;
  if (now() > order.expire_at + PAY_GRACE_MS) {
    const r = await run(
      "UPDATE orders SET status = 'EXPIRED', next_run_at = NULL, updated_at = $1 WHERE id = $2 AND status = 'PENDING_PAYMENT'",
      now(),
      order.id,
    );
    if (r.changes) await log(order.id, 'EXPIRED');
  } else {
    // 查单期间可能已被回调标记为已支付，所以只在仍是待支付时才续期
    await run(
      "UPDATE orders SET next_run_at = $1, updated_at = $2 WHERE id = $3 AND status = 'PENDING_PAYMENT'",
      now() + 30e3,
      now(),
      order.id,
    );
  }
}

/** 锁定一张可用卡密。FOR UPDATE SKIP LOCKED：多个 worker 并发时各自拿到不同的卡，互不等待 */
function allocateCard(order: Order): Promise<Card | undefined> {
  return tx(async (db) => {
    const card = await db.get<Card>(
      `UPDATE card_keys SET status = 'LOCKED', order_id = $1, locked_at = $2
       WHERE id = (
         SELECT id FROM card_keys WHERE plan_id = $3 AND status = 'AVAILABLE'
         ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED
       )
       RETURNING id, code`,
      order.id,
      now(),
      order.plan_id,
    );
    if (card) {
      // 租约校验失败会抛错并回滚事务，刚锁定的卡密随之释放
      await update(order, { card_id: card.id }, db);
      await log(order.id, 'CARD_LOCKED', `card#${card.id}`, db);
    }
    return card;
  });
}

/** 调用上游核对卡密；上游不支持或接口不通时返回 undefined（不阻塞流程，提交时还会再判断） */
async function checkCard(order: Order, card: Card) {
  if (!upstream.checkCard) return undefined;
  try {
    return await upstream.checkCard(card.code);
  } catch (e) {
    console.warn(`[worker] 卡密核对失败 ${order.order_no}: ${(e as Error).message}`);
    return undefined;
  }
}

/**
 * 付款成功后：立即锁定一张卡密并向上游核对状态，坏卡当场作废换下一张。
 * 这样用户来填 Token 时，订单手里已经是一张确认可用的卡。
 * 处理完把 next_run_at 置空，订单停在 PAID 等用户提交 Token。
 */
async function processPaid(paid: Order): Promise<void> {
  const order = await claim(paid);
  if (!order) return;
  if (order.card_id) return update(order, { next_run_at: null });

  const card = await allocateCard(order);
  // 没有库存：一分钟后再试（补货后自动分配）
  if (!card) return update(order, { next_run_at: now() + 60e3 });

  const bound = { ...order, card_id: card.id };
  const check = await checkCard(bound, card);
  if (check && check.cardStatus !== 'UNUSED') {
    // 坏卡：作废并解绑，马上再分配下一张
    const reason = `付款后核对未通过：${check.detail}`;
    await tx(async (db) => {
      await update(bound, { card_id: null, next_run_at: now() }, db);
      await setCard(db, card.id, 'INVALID', `订单 ${order.order_no}: ${reason}`);
      await log(order.id, 'CARD_INVALID', reason, db);
    });
    return;
  }
  if (check) await log(order.id, 'CARD_CHECKED', `card#${card.id} ${check.detail}`);
  await update(bound, { next_run_at: null });
}

async function processQueued(queued: Order): Promise<void> {
  const claimed = await claim(queued);
  if (!claimed) return;
  let order = claimed;

  let card: Card | undefined;
  if (order.card_id) {
    card = await get<Card>('SELECT id, code FROM card_keys WHERE id = $1', order.card_id);
    if (!card) return toManual(order, `绑定的卡密 #${order.card_id} 不存在`);
  } else {
    card = await allocateCard(order);
    if (!card) {
      await update(order, { message: '库存补货中，补货后将自动为您充值', next_run_at: now() + 60e3 });
      return;
    }
    order = { ...order, card_id: card.id };
  }
  const tokenEnc = order.token_enc;
  if (!tokenEnc) return toManual(order, 'Token 缺失');

  // 首次提交前先向上游核对卡密状态：库存里的卡可能早已被用掉或作废，提前换掉，不拿用户的登录信息去试错。
  // 只在还没提交过时核对 —— 提交过之后卡密显示「核销中 / 已使用」可能正是本单造成的，不能据此换卡。
  // （付款时已经核对过一次，但用户可能隔很久才来填 Token，提交前再确认一遍）
  if (order.submit_attempts === 0) {
    const check = await checkCard(order, card);
    if (check && check.cardStatus !== 'UNUSED') return switchCard(order, `提交前核对未通过：${check.detail}`, false);
  }

  // 先持久化提交次数再调用上游：即使进程在调用后崩溃，重启重试时也知道"之前可能已提交过"
  order = { ...order, submit_attempts: order.submit_attempts + 1 };
  await update(order, { submit_attempts: order.submit_attempts });

  let result: SubmitResult;
  try {
    result = await upstream.submit(card.code, decrypt(tokenEnc));
  } catch (e) {
    // 不确定是否已送达上游：用同一张卡重试，不换卡
    const msg = (e as Error).message;
    await log(order.id, 'SUBMIT_ERROR', `#${order.submit_attempts} ${msg}`);
    if (order.submit_attempts >= config.redeemMaxSubmitRetries) return toManual(order, `提交上游连续失败: ${msg}`);
    await update(order, { next_run_at: now() + 30e3 * order.submit_attempts });
    return;
  }

  if (result.type === 'BUSY') {
    // 上游确定没有受理：这次不算提交，卡密保持锁定，一分钟后原样重试。只在第一次记日志，避免长时间暂停时刷屏
    const message = '充值通道繁忙，恢复后将自动为您充值，无需重复操作';
    if (order.message !== message) await log(order.id, 'UPSTREAM_BUSY', result.reason);
    await update(order, { submit_attempts: order.submit_attempts - 1, message, next_run_at: now() + 60e3 });
    return;
  }

  await log(order.id, 'SUBMIT_RESULT', result);
  switch (result.type) {
    case 'ACCEPTED':
      await update(order, {
        status: 'REDEEMING',
        upstream_task_id: result.taskId,
        query_attempts: 0,
        message: '充值处理中',
        next_run_at: now() + config.redeemQueryIntervalSec * 1000,
      });
      return;
    case 'SUCCESS':
      return finishSuccess(order);
    case 'REJECTED':
      return handleRejection(order, result);
    default:
      return assertNever(result, '未知提交结果');
  }
}

function handleRejection(order: Order, { reason, cardStatus }: Rejection): Promise<void> {
  switch (cardStatus) {
    case 'UNUSED':
      return finishFailedReleaseCard(order, reason);
    case 'INVALID':
      // 这张卡之前有过不确定的提交，此时"卡密已被使用"可能正是我们自己用掉的 → 不能换卡，转人工
      if (order.submit_attempts > 1) return toManual(order, `重试后卡密显示已使用，可能已兑换成功: ${reason}`);
      if (order.card_switches >= MAX_CARD_SWITCHES) return toManual(order, `连续 ${MAX_CARD_SWITCHES} 张卡密无效`);
      return switchCard(order, reason);
    case 'UNKNOWN':
      return toManual(order, reason);
    default:
      return assertNever(cardStatus, '未知卡密状态');
  }
}

async function processRedeeming(redeeming: Order): Promise<void> {
  const order = await claim(redeeming);
  if (!order) return;
  if (!order.upstream_task_id) return toManual(order, '缺少上游任务号');
  const attempts = order.query_attempts + 1;
  let result: QueryResult;
  try {
    result = await upstream.query(order.upstream_task_id);
  } catch (e) {
    result = { type: 'PENDING', error: (e as Error).message };
  }

  switch (result.type) {
    case 'SUCCESS':
      return finishSuccess(order);
    case 'FAILED':
      await log(order.id, 'QUERY_FAILED', result);
      return handleRejection({ ...order, submit_attempts: 1 }, result);
    case 'PENDING': {
      if (attempts >= config.redeemMaxQueries) return toManual(order, `查询 ${attempts} 次仍未出结果${result.error ? `（最后一次: ${result.error}）` : ''}`);
      // 查询接口本身不通（上游维护、网络问题）时放慢到每分钟一次：一次十分钟的维护只消耗约 10 次额度，不至于把订单耗到转人工
      const delay = result.error ? Math.max(60, config.redeemQueryIntervalSec) : config.redeemQueryIntervalSec;
      await update(order, { query_attempts: attempts, next_run_at: now() + delay * 1000 });
      return;
    }
    default:
      return assertNever(result, '未知查询结果');
  }
}

// ---------- 调度 ----------

const handlers: Partial<Record<OrderStatus, (o: Order) => Promise<void>>> = {
  PENDING_PAYMENT: processPendingPayment,
  PAID: processPaid,
  QUEUED: processQueued,
  REDEEMING: processRedeeming,
};

let running = false;
export async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    // 已付款待充值的订单优先：大量未付款订单等待查单时，不能挤占已付款用户的充值
    const due = await all<Order>(
      `SELECT * FROM orders WHERE status IN ('PENDING_PAYMENT', 'PAID', 'QUEUED', 'REDEEMING')
         AND next_run_at IS NOT NULL AND next_run_at <= $1
       ORDER BY (status = 'PENDING_PAYMENT'), next_run_at LIMIT $2`,
      now(),
      BATCH,
    );
    await Promise.all(
      due.map(async (o) => {
        try {
          await handlers[o.status]?.(o);
        } catch (e) {
          if (e instanceof LeaseLostError) {
            // 不是故障：后台人工操作优先，worker 的结果作废。留一条日志便于核对上游是否已实际兑换
            console.warn(`[worker] ${e.message}`);
            await log(o.id, 'WORKER_CONFLICT', e.message).catch(() => {});
            return;
          }
          console.error(`[worker] 订单 ${o.order_no} 处理异常`, e);
          await log(o.id, 'WORKER_ERROR', (e as Error).message).catch(() => {});
        }
      }),
    );
  } catch (e) {
    console.error('[worker] 调度异常', e);
  } finally {
    running = false;
  }
}

let timer: NodeJS.Timeout | undefined;
export function start(): void {
  // 进程重启后，被租约卡住的订单在租约到期后会自动被重新处理
  timer = setInterval(() => void tick(), config.workerIntervalMs);
  void tick();
}

/** 停止调度并等待当前批次结束（优雅退出用） */
export async function stop(): Promise<void> {
  if (timer) clearInterval(timer);
  while (running) await new Promise((r) => setTimeout(r, 100));
}
