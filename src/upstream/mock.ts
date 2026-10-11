// 模拟上游，便于本地跑通完整流程：
//   Token 含 "bad"      → 提交即拒绝（Token 无效，卡密未消耗）
//   Token 含 "failtask" → 受理后查询结果为失败
//   卡密含 "BAD"        → 卡密无效（系统会自动换卡）
//   其他                → 受理，约 15 秒后查询为成功
import crypto from 'node:crypto';
import type { UpstreamDriver } from '../types.ts';

const tasks = new Map<string, { doneAt: number; fail: boolean }>();

const mock: UpstreamDriver = {
  async submit(card, token) {
    await new Promise((r) => setTimeout(r, 300));
    if (/bad/i.test(token)) return { type: 'REJECTED', reason: 'Token 无效或已过期', cardStatus: 'UNUSED' };
    if (/BAD/.test(card)) return { type: 'REJECTED', reason: '卡密无效', cardStatus: 'INVALID' };
    const taskId = crypto.randomUUID();
    tasks.set(taskId, { doneAt: Date.now() + 15000, fail: /failtask/i.test(token) });
    return { type: 'ACCEPTED', taskId };
  },

  async query(taskId) {
    const t = tasks.get(taskId);
    if (!t) throw new Error('任务不存在');
    if (Date.now() < t.doneAt) return { type: 'PENDING' };
    return t.fail ? { type: 'FAILED', reason: '账号不满足充值条件', cardStatus: 'UNUSED' } : { type: 'SUCCESS' };
  },
};

export default mock;
