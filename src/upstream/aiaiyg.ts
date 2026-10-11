// aiaiyg.com 卡密核销上游。三个接口（均无需鉴权）：
//   POST /api/voucher/status        body: { codes: [卡密] }      → 卡密当前状态（unused / used / reserved / not_found …）
//   POST /api/plus/redeem/submit    body: { code: 卡密, text }   → { ok, rid, view_token }；text 是用户的 session JSON 原文
//   GET  /api/redeem/status?rid=&token=                          → { ok, state, code_returned, voucher_current_state, … }
//
// 判断卡密去向时一律以上游返回的卡密实际状态为准，不靠错误文案猜。
import config from '../config.ts';
import type { QueryResult, UpstreamCardStatus, UpstreamDriver } from '../types.ts';

const cfg = config.upstream;
const BASE = (cfg.baseUrl || 'https://aiaiyg.com').replace(/\/$/, '');
/** 上游建单可能要几十秒，提交单独用更长的超时（必须小于 worker 的租约 120 秒） */
const SUBMIT_TIMEOUT_MS = 90_000;

interface SubmitResponse {
  ok?: boolean;
  rid?: string;
  view_token?: string;
  code?: string;
  error?: string;
  detail?: string;
  already_plus?: boolean;
}

interface StatusResponse {
  ok?: boolean;
  error?: string;
  /** queued / 处理中的各种状态 / success / failed / cancelled / interrupted / stuck */
  state?: string;
  message?: string;
  reason?: string;
  token_code?: string;
  token_invalid?: boolean;
  already_plus?: boolean;
  manual_review?: boolean;
  /** 卡密是否已退回；code_returned_known 为 false 表示上游还没确定 */
  code_returned?: boolean;
  code_returned_known?: boolean;
  voucher_current_state?: string;
  voucher_reusable?: boolean;
  /** 上游要求用户做额外验证，期间不算结束 */
  verification?: { required?: boolean };
}

interface VoucherResponse {
  ok?: boolean;
  error?: string;
  results?: { code: string; found?: boolean; status?: string; status_text?: string; email?: string }[];
}

async function request<T>(method: 'GET' | 'POST', path: string, body?: object, timeoutMs = cfg.timeoutMs): Promise<{ status: number; json: T }> {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      Origin: BASE,
      Referer: `${BASE}/`,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text) as T };
  } catch {
    throw new Error(`上游返回的不是 JSON（HTTP ${res.status}）`);
  }
}

/** 查询卡密当前状态 */
async function voucher(code: string): Promise<{ status: string; email: string }> {
  const { status, json } = await request<VoucherResponse>('POST', '/api/voucher/status', { codes: [code] });
  if (!json.ok) throw new Error(`上游卡密查询失败: ${json.error || status}`);
  const item = json.results?.find((r) => r.code === code);
  if (!item) throw new Error('上游卡密查询未返回该卡密');
  return { status: item.found === false ? 'not_found' : (item.status ?? ''), email: item.email ?? '' };
}

function mapVoucher(status: string): UpstreamCardStatus {
  if (status === 'unused') return 'UNUSED';
  if (status === 'used' || status === 'not_found' || status === 'revoked') return 'INVALID';
  // reserved（核销中）/ stuck / frozen 等：说不清，交给人工
  return 'UNKNOWN';
}

/** 从 session JSON 里取账号邮箱，用于核对「这张卡是不是充到了这个账号」 */
function sessionEmail(text: string): string {
  try {
    const email = (JSON.parse(text) as { user?: { email?: unknown } }).user?.email;
    return typeof email === 'string' ? email.trim().toLowerCase() : '';
  } catch {
    return '';
  }
}

/** 确定没有受理、稍后原样重试即可的情况 */
// service_unavailable 是上游维护时返回的（HTTP 503）：明确表示没有受理
const BUSY_CODES = new Set(['queue_full', 'not_ready', 'intake_paused', 'service_unavailable']);

/** 给用户看的失败原因（上游的错误码 → 中文） */
const REASONS: Record<string, string> = {
  already_plus: '该账号已是付费会员，无法重复充值',
  bad_session: '登录信息无效，请重新复制',
  no_session_token: '登录信息无效，请重新复制',
  token_format_error: '登录信息格式不正确，请重新复制',
  token_invalid: '登录信息已失效，请重新复制',
  token_invalidated: '登录信息已失效，请重新复制',
  token_expired: '登录信息已过期，请重新复制',
  token_jwt_invalid: '登录信息已失效，请重新复制',
  token_jwt_time_invalid: '登录信息已过期，请重新复制',
  session_invalidated: '登录信息已失效，请重新复制',
  inflight: '该账号有一笔充值正在进行中',
  account_stuck: '该账号有一笔充值正在核验中',
  hcaptcha_account_blocked: '该账号暂时无法充值',
};
const clean = (s: string | undefined): string => (s ?? '').trim().replace(/[。.！!]+$/, '');

const aiaiyg: UpstreamDriver = {
  needsSession: true,

  async checkCard(card) {
    const v = await voucher(card);
    return { cardStatus: mapVoucher(v.status), detail: `上游卡密状态 ${v.status || '未知'}` };
  },

  async checkCards(cards) {
    const out = new Map<string, { cardStatus: UpstreamCardStatus; detail: string }>();
    // 上游单次最多查 100 张，分批顺序查询
    for (let i = 0; i < cards.length; i += 100) {
      const { status, json } = await request<VoucherResponse>('POST', '/api/voucher/status', { codes: cards.slice(i, i + 100) });
      if (!json.ok) throw new Error(`上游卡密查询失败: ${json.error || status}`);
      for (const item of json.results ?? []) {
        const s = item.found === false ? 'not_found' : (item.status ?? '');
        // 说明文字直接用上游返回的 status_text
        out.set(item.code, { cardStatus: mapVoucher(s), detail: item.status_text || s || '未知' });
      }
    }
    return out;
  },

  async submit(card, text) {
    const { status, json } = await request<SubmitResponse>('POST', '/api/plus/redeem/submit', { code: card, text }, SUBMIT_TIMEOUT_MS);
    // 5xx 一般当作「不确定是否送达」；但上游明确给出繁忙/维护错误码时，说明确实没受理，走下面的 BUSY
    if (status >= 500 && !BUSY_CODES.has(json.code ?? '')) throw new Error(`上游 HTTP ${status}`);
    if (json.ok) {
      if (json.rid && json.view_token) return { type: 'ACCEPTED', taskId: `${json.rid}:${json.view_token}` };
      throw new Error('上游已受理但没有返回查询凭据');
    }

    const code = json.already_plus ? 'already_plus' : (json.code ?? '');
    const reason = REASONS[code] || clean(json.detail || json.error) || '上游拒绝';
    if (status === 429 || BUSY_CODES.has(code)) return { type: 'BUSY', reason };

    // 被拒绝后查一次卡密的实际状态，据此决定卡密去向
    let v: Awaited<ReturnType<typeof voucher>>;
    try {
      v = await voucher(card);
    } catch (e) {
      return { type: 'REJECTED', reason: `${reason}（卡密状态查询失败: ${(e as Error).message}）`, cardStatus: 'UNKNOWN' };
    }
    // 卡密已用且兑换账号就是本单账号：是之前那次结果不明的提交实际成功了
    const email = sessionEmail(text);
    if (v.status === 'used' && email && v.email.trim().toLowerCase() === email) return { type: 'SUCCESS' };
    return { type: 'REJECTED', reason: `${reason}（上游错误码 ${code || status}，卡密状态 ${v.status || '未知'}）`, cardStatus: mapVoucher(v.status) };
  },

  async query(taskId): Promise<QueryResult> {
    const i = taskId.indexOf(':');
    const rid = taskId.slice(0, i);
    const token = taskId.slice(i + 1);
    const { status, json: d } = await request<StatusResponse>(
      'GET',
      `/api/redeem/status?rid=${encodeURIComponent(rid)}&token=${encodeURIComponent(token)}`,
    );
    if (!d.ok) throw new Error(`上游查询失败: ${d.error || status}`);

    if (d.state === 'success') return { type: 'SUCCESS' };
    if (d.verification?.required) return { type: 'PENDING' };
    if (d.state === 'stuck' || d.manual_review) {
      return { type: 'FAILED', reason: `上游转人工核验: ${clean(d.message) || d.reason || ''}`, cardStatus: 'UNKNOWN' };
    }
    if (d.state !== 'failed' && d.state !== 'cancelled' && d.state !== 'interrupted') return { type: 'PENDING' };

    // 已失败，但卡密是否退回上游还没确定：继续等
    if (d.code_returned !== true && d.code_returned_known === false) return { type: 'PENDING' };

    const code = d.already_plus ? 'already_plus' : d.token_invalid ? 'token_invalid' : (d.token_code || d.reason || '');
    const reason = REASONS[code.toLowerCase()] || clean(d.message) || '充值失败';
    // 只有上游明确「卡密已退回且可再次使用」才把卡放回库存；其余情况（未退回、退回但不可用）转人工
    const returned = d.code_returned === true && d.voucher_reusable !== false && (d.voucher_current_state ?? 'unused') === 'unused';
    return { type: 'FAILED', reason, cardStatus: returned ? 'UNUSED' : 'UNKNOWN' };
  },
};

export default aiaiyg;
