// ============ 数据库行 ============

/**
 * 订单状态:
 *   PENDING_PAYMENT 待支付 -> PAID 已支付待填 Token -> QUEUED 已提交 Token 等待处理
 *   -> REDEEMING 已向上游提交兑换 -> SUCCESS / FAILED
 *   EXPIRED 超时未支付；MANUAL_REVIEW 结果不确定需人工处理；REFUNDED 已退款
 */
export type OrderStatus =
  | 'PENDING_PAYMENT'
  | 'PAID'
  | 'QUEUED'
  | 'REDEEMING'
  | 'SUCCESS'
  | 'FAILED'
  | 'EXPIRED'
  | 'MANUAL_REVIEW'
  | 'REFUNDED';

/** 卡密状态: AVAILABLE 可用 / LOCKED 已绑定订单(兑换中) / USED 已使用 / INVALID 作废 */
export type CardStatus = 'AVAILABLE' | 'LOCKED' | 'USED' | 'INVALID';

export type PayChannel = 'mock' | 'alipay' | 'wechat';

/** 时间戳均为毫秒；金额均为「分」 */
export interface Plan {
  id: number;
  name: string;
  description: string;
  price_cents: number;
  sort: number;
  active: 0 | 1;
  created_at: number;
}

export interface CardKey {
  id: number;
  plan_id: number;
  code: string;
  status: CardStatus;
  order_id: number | null;
  note: string;
  created_at: number;
  locked_at: number | null;
  used_at: number | null;
}

export interface Order {
  id: number;
  order_no: string;
  access_key: string;
  plan_id: number;
  plan_name: string;
  amount_cents: number;
  pay_channel: PayChannel;
  pay_qr: string | null;
  pay_trade_no: string | null;
  status: OrderStatus;
  token_enc: string | null;
  token_mask: string | null;
  card_id: number | null;
  upstream_task_id: string | null;
  token_attempts: number;
  submit_attempts: number;
  card_switches: number;
  query_attempts: number;
  next_run_at: number | null;
  message: string;
  created_at: number;
  expire_at: number;
  paid_at: number | null;
  token_at: number | null;
  finished_at: number | null;
  updated_at: number;
  client_ip: string;
  /** 充值账号邮箱，从用户提交的 Token 中解析；解析不到时为空串 */
  account_email: string;
}

// ============ 支付渠道 ============

export interface PaymentResult {
  paid: boolean;
  tradeNo?: string;
  amountCents?: number;
}

export interface PaymentNotify extends Required<PaymentResult> {
  orderNo: string;
}

export interface CreateQrParams {
  orderNo: string;
  amountCents: number;
  subject: string;
  expireAt: number;
  /** 下单的设备是不是手机：有的渠道电脑和手机走不同的支付产品 */
  mobile?: boolean;
}

/** 回调所需的最小请求信息，便于脱离 Express 单独测试 */
export interface NotifyRequest {
  body?: Record<string, string>;
  rawBody?: string;
  get(header: string): string | undefined;
}

export interface NotifyResponder {
  status(code: number): NotifyResponder;
  type(t: string): NotifyResponder;
  send(body: string): unknown;
  json(body: unknown): unknown;
  end(): unknown;
}

export interface PaymentProvider {
  name: PayChannel;
  label: string;
  /**
   * 发起支付。返回值存进订单的 pay_qr，有两种形态：
   *   - 二维码内容：页面把它画成二维码，用户扫码付款
   *   - 收银台链接：页面给出按钮，用户跳转到支付平台的页面付款（由 isLink 判断）
   */
  createQr(params: CreateQrParams): Promise<{ qr: string }>;
  /** pay_qr 是不是一个需要跳转打开的收银台链接（而不是二维码内容）。不实现则一律当作二维码 */
  isLink?(payQr: string): boolean;
  /** 这个收银台链接是不是只返回一个二维码、专门用来嵌在我们页面里的（而不是完整的收银台页面） */
  isEmbed?(payQr: string): boolean;
  query(orderNo: string): Promise<PaymentResult>;
  /** 只有支持异步通知的渠道才需要实现（mock 没有） */
  parseNotify?(req: NotifyRequest): PaymentNotify;
  ackSuccess?(res: NotifyResponder): unknown;
  ackFail?(res: NotifyResponder): unknown;
}

// ============ 上游兑换 ============

/**
 * 上游失败时卡密的去向：
 *   UNUSED  卡密未被消耗（如 Token 无效）→ 释放卡密回库存，订单失败
 *   INVALID 卡密本身无效/已被用 → 卡密作废，自动换一张重试
 *   UNKNOWN 无法确定 → 转人工
 */
export type UpstreamCardStatus = 'UNUSED' | 'INVALID' | 'UNKNOWN';

export type SubmitResult =
  | { type: 'ACCEPTED'; taskId: string }
  | { type: 'SUCCESS' }
  /** 上游繁忙/暂停接单，确定没有受理：卡密和订单都不变，稍后原样重试 */
  | { type: 'BUSY'; reason: string }
  | { type: 'REJECTED'; reason: string; cardStatus: UpstreamCardStatus };

export type QueryResult =
  | { type: 'PENDING'; error?: string }
  | { type: 'SUCCESS' }
  | { type: 'FAILED'; reason: string; cardStatus: UpstreamCardStatus };

/**
 * 上游兑换驱动。业务代码只依赖这里的标准返回值，接入真实上游时只需实现这个接口。
 * submit / query 抛出异常 = 网络/超时等不确定情况，由 worker 按次数重试后转人工。
 */
export interface UpstreamDriver {
  /**
   * 为 true 时，用户必须提交 chatgpt.com/api/auth/session 的整页 JSON（含 sessionToken），
   * submit 收到的 token 就是这段 JSON 原文；否则只需要 accessToken。
   */
  needsSession?: boolean;
  /**
   * 向上游查询卡密当前状态（只读，不消耗卡密）。实现了的话，worker 会在首次提交前先核对：
   * 不是 UNUSED 的卡直接作废换下一张，不会拿去提交。
   */
  checkCard?(cardCode: string): Promise<{ cardStatus: UpstreamCardStatus; detail: string }>;
  /** 批量版 checkCard，后台导入卡密时用：只有 UNUSED 的才允许入库。结果里没有的卡密视为查不到 */
  checkCards?(cardCodes: string[]): Promise<Map<string, { cardStatus: UpstreamCardStatus; detail: string }>>;
  submit(cardCode: string, token: string): Promise<SubmitResult>;
  query(taskId: string): Promise<QueryResult>;
}

// ============ 其他 ============

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** 编译期穷尽检查：switch 漏掉某个分支时这里会报类型错误 */
export function assertNever(x: never, msg = '未处理的分支'): never {
  throw new Error(`${msg}: ${JSON.stringify(x)}`);
}
