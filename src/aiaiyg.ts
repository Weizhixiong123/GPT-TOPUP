// aiaiyg.com 卡密核销接口（均无需鉴权）。本站只做中转，不保存任何数据：
//   POST /api/voucher/status        body: { codes: [卡密] }      → 卡密当前状态（unused / used / reserved / not_found …）
//   POST /api/plus/redeem/submit    body: { code: 卡密, text }   → { ok, rid, view_token }；text 是用户的 session JSON 原文
//   GET  /api/redeem/status?rid=&token=                          → { ok, state, code_returned, voucher_current_state, … }
// 返回给买家的文案都在这里翻译成本站自己的说法，不透出上游的原始提示。
import config from './config.ts';
import { HttpError } from './types.ts';

const BASE = config.upstream.baseUrl.replace(/\/$/, '');
/** 上游建单可能要几十秒，提交单独用更长的超时 */
const SUBMIT_TIMEOUT_MS = 90_000;

async function request<T>(method: 'GET' | 'POST', path: string, body?: object, timeoutMs = config.upstream.timeoutMs): Promise<{ status: number; json: T }> {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
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
  } catch (e) {
    console.warn(`[aiaiyg] ${method} ${path} 请求失败: ${(e as Error).message}`);
    throw new HttpError(502, '充值通道连接失败，请稍后再试');
  }
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text) as T };
  } catch {
    console.warn(`[aiaiyg] ${method} ${path} 返回的不是 JSON（HTTP ${res.status}）`);
    throw new HttpError(502, '充值通道暂时不可用，请稍后再试');
  }
}

// ---------- 第 1 步：查卡密状态 ----------

interface VoucherResponse {
  ok?: boolean;
  error?: string;
  results?: { code: string; found?: boolean; status?: string; email?: string }[];
}

export type CodeState = 'UNUSED' | 'USED' | 'REDEEMING' | 'INVALID';

export async function checkCode(code: string): Promise<{ state: CodeState; email: string }> {
  const { status, json } = await request<VoucherResponse>('POST', '/api/voucher/status', { codes: [code] });
  if (!json.ok) {
    console.warn(`[aiaiyg] 卡密查询失败: ${json.error || status}`);
    throw new HttpError(502, '卡密查询失败，请稍后再试');
  }
  const item = json.results?.find((r) => r.code === code);
  const s = !item || item.found === false ? 'not_found' : (item.status ?? '');
  const email = item?.email ?? '';
  if (s === 'not_found') throw new HttpError(404, '卡密不存在，请检查是否输入正确');
  if (s === 'unused') return { state: 'UNUSED', email };
  if (s === 'used') return { state: 'USED', email };
  // reserved（核销中）等：正在充值
  if (s === 'reserved') return { state: 'REDEEMING', email };
  // revoked（作废）、frozen 等
  return { state: 'INVALID', email };
}

// ---------- 第 3 步：提交充值 ----------

interface SubmitResponse {
  ok?: boolean;
  rid?: string;
  view_token?: string;
  code?: string;
  error?: string;
  detail?: string;
  already_plus?: boolean;
}

/** 上游的错误码 → 给买家看的原因 */
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
  inflight: '该账号有一笔充值正在进行中，请稍后再试',
  account_stuck: '该账号有一笔充值正在核验中，请稍后再试',
  hcaptcha_account_blocked: '该账号暂时无法充值，请联系客服',
};
/** 确定没有受理、稍后再试即可的情况（service_unavailable 是上游维护时返回的） */
const BUSY_CODES = new Set(['queue_full', 'not_ready', 'intake_paused', 'service_unavailable']);

/** 提交成功返回查询凭据（rid + token），之后用它查询进度 */
export async function submit(code: string, session: string): Promise<{ rid: string; token: string }> {
  const { status, json } = await request<SubmitResponse>('POST', '/api/plus/redeem/submit', { code, text: session }, SUBMIT_TIMEOUT_MS);
  if (json.ok && json.rid && json.view_token) return { rid: json.rid, token: json.view_token };
  const errCode = json.already_plus ? 'already_plus' : (json.code ?? '');
  console.warn(`[aiaiyg] 提交被拒绝: HTTP ${status} ${errCode} ${json.detail || json.error || ''}`);
  if (status === 429 || BUSY_CODES.has(errCode)) throw new HttpError(503, '充值通道繁忙，请稍后再试（卡密未被使用）');
  if (status >= 500) throw new HttpError(502, '提交结果不确定，请稍后重新输入卡密查看状态，不要重复购买');
  throw new HttpError(400, REASONS[errCode] || '充值提交失败，请检查卡密和登录信息后重试');
}

// ---------- 第 4 步：查询进度 ----------

interface StatusResponse {
  ok?: boolean;
  error?: string;
  state?: string;
  message?: string;
  reason?: string;
  token_code?: string;
  token_invalid?: boolean;
  already_plus?: boolean;
  manual_review?: boolean;
  code_returned?: boolean;
  code_returned_known?: boolean;
  voucher_current_state?: string;
  voucher_reusable?: boolean;
  verification?: { required?: boolean };
}

export interface Progress {
  /** PENDING 充值中 / SUCCESS 成功 / FAILED 失败 / MANUAL 需人工处理 */
  state: 'PENDING' | 'SUCCESS' | 'FAILED' | 'MANUAL';
  message: string;
  /** 失败且卡密已退回、可以再次使用：买家换一份登录信息重新提交即可 */
  can_retry: boolean;
}

export async function progress(rid: string, token: string): Promise<Progress> {
  const { status, json: d } = await request<StatusResponse>('GET', `/api/redeem/status?rid=${encodeURIComponent(rid)}&token=${encodeURIComponent(token)}`);
  if (!d.ok) {
    if (status === 404) throw new HttpError(404, '充值记录不存在');
    console.warn(`[aiaiyg] 进度查询失败: ${d.error || status}`);
    throw new HttpError(502, '进度查询失败，稍后会自动重试');
  }
  if (d.state === 'success') return { state: 'SUCCESS', message: '充值成功，刷新 ChatGPT 即可看到会员状态', can_retry: false };
  if (d.state === 'stuck' || d.manual_review) return { state: 'MANUAL', message: '充值需要人工核实，请联系客服处理', can_retry: false };
  const finished = d.state === 'failed' || d.state === 'cancelled' || d.state === 'interrupted';
  // 还在处理，或已失败但卡密是否退回还没确定：继续等
  if (!finished || (d.code_returned !== true && d.code_returned_known === false)) {
    return { state: 'PENDING', message: d.state === 'queued' ? '排队中，请稍候' : '充值处理中，请勿关闭页面', can_retry: false };
  }
  const errCode = (d.already_plus ? 'already_plus' : d.token_invalid ? 'token_invalid' : (d.token_code || d.reason || '')).toLowerCase();
  const returned = d.code_returned === true && d.voucher_reusable !== false && (d.voucher_current_state ?? 'unused') === 'unused';
  const reason = REASONS[errCode] || '充值失败';
  return returned
    ? { state: 'FAILED', message: `${reason}。卡密未被消耗，可重新提交`, can_retry: true }
    : { state: 'MANUAL', message: `${reason}，请联系客服处理`, can_retry: false };
}
