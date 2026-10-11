// 通用 HTTP 上游驱动 —— 这里的接口路径/字段是示例约定，请按你的上游实际文档修改。
//   POST {base}/redeem          body: { card, token }        → { code: 0, data: { task_id } }
//   GET  {base}/redeem/:taskId                                → { code: 0, data: { status: pending|success|failed, message, card_status } }
import config from '../config.ts';
import type { UpstreamCardStatus, UpstreamDriver } from '../types.ts';

const cfg = config.upstream;

/** 上游响应结构（示例，按实际文档调整） */
interface UpstreamResponse {
  code: number;
  message?: string;
  data?: {
    task_id?: string | number;
    status?: 'pending' | 'success' | 'failed';
    message?: string;
    card_status?: string;
  };
}

async function request(method: 'GET' | 'POST', path: string, body?: object): Promise<UpstreamResponse> {
  const res = await fetch(cfg.baseUrl.replace(/\/$/, '') + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
  if (res.status >= 500) throw new Error(`上游 HTTP ${res.status}`);
  return (await res.json()) as UpstreamResponse;
}

// 把上游的卡密状态映射为标准值
function mapCardStatus(s: string | undefined): UpstreamCardStatus {
  if (s === 'unused') return 'UNUSED';
  if (s === 'invalid' || s === 'used') return 'INVALID';
  return 'UNKNOWN';
}

const http: UpstreamDriver = {
  async submit(card, token) {
    const json = await request('POST', '/redeem', { card, token });
    if (json.code === 0 && json.data?.task_id) return { type: 'ACCEPTED', taskId: String(json.data.task_id) };
    if (json.code === 0 && json.data?.status === 'success') return { type: 'SUCCESS' };
    return { type: 'REJECTED', reason: json.message || '上游拒绝', cardStatus: mapCardStatus(json.data?.card_status) };
  },

  async query(taskId) {
    const json = await request('GET', `/redeem/${encodeURIComponent(taskId)}`);
    if (json.code !== 0) throw new Error(`上游查询失败: ${json.message}`);
    const d = json.data ?? {};
    if (d.status === 'success') return { type: 'SUCCESS' };
    if (d.status === 'failed') return { type: 'FAILED', reason: d.message || '兑换失败', cardStatus: mapCardStatus(d.card_status) };
    return { type: 'PENDING' };
  },
};

export default http;
