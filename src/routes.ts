import express, { type Request, type Response, type NextFunction } from 'express';
import config from './config.ts';
import * as aiaiyg from './aiaiyg.ts';
import { failureGuard, rateLimit } from './ratelimit.ts';
import { HttpError } from './types.ts';

const router = express.Router();
const MIN = 60e3;
const HOUR = 3600e3;
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

// 输错卡密计入失败次数：同一 IP 15 分钟内错 20 次就暂停，防止有人批量猜卡密
const guard = failureGuard('redeem-code', 20, 15 * MIN);

/** 包一层：统一处理异步异常；输错卡密（404）计入失败次数 */
function handle(fn: (req: Request) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.ip ?? '';
    const wait = guard.blocked(ip);
    if (wait) {
      res.set('Retry-After', String(wait));
      return next(new HttpError(429, `卡密输错次数过多，请 ${Math.ceil(wait / 60)} 分钟后再试`));
    }
    fn(req)
      .then((data) => res.json(data))
      .catch((e) => {
        if (e instanceof HttpError && e.status === 404) guard.fail(ip);
        next(e);
      });
  };
}

/** 卡密只做基本格式检查（支持多种格式），具体真假交给上游判断 */
function readCode(v: unknown): string {
  const code = str(v);
  if (code.length < 8 || code.length > 128 || !/^[\w-]+$/.test(code)) throw new HttpError(404, '卡密不存在，请检查是否输入正确');
  return code;
}

/** 登录信息：必须是 chatgpt.com/api/auth/session 的整页 JSON（含 sessionToken） */
function readSession(v: unknown): string {
  const text = str(v);
  // 整页 JSON 里有大段与登录无关的追踪配置，实测已超过 3.2 万字符，上限留足余量
  if (text.length < 20 || text.length > 100_000 || !text.startsWith('{')) throw new HttpError(400, '请复制页面的全部内容（按 Ctrl+A 全选），不要只复制其中一段');
  let json: { sessionToken?: unknown };
  try {
    json = JSON.parse(text);
  } catch {
    throw new HttpError(400, '内容不完整，请重新全选复制');
  }
  // 不可见的控制字符 / 零宽字符会让上游判定格式错误，提前拦下
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‍⁠﻿]/.test(text)) throw new HttpError(400, '内容里含有异常字符，请重新全选复制');
  if (typeof json.sessionToken !== 'string' || !json.sessionToken.startsWith('eyJ')) {
    throw new HttpError(400, '没有找到登录信息，请先登录 chatgpt.com 再重新复制');
  }
  return text;
}

// 「联系客服」小窗的内容（见 public/support.js）
router.get('/support', rateLimit('support', [{ scope: 'ip', max: 60, windowMs: MIN }]), (_req, res) => {
  res.json(config.support);
});

/** 第 1 步：验证卡密 */
router.post(
  '/redeem/check',
  rateLimit('redeem-check', [{ scope: 'ip', max: 30, windowMs: MIN }]),
  handle(async (req) => {
    const r = await aiaiyg.checkCode(readCode(req.body.code));
    if (r.state === 'INVALID') throw new HttpError(410, '该卡密已失效，请联系卖家');
    // 已使用 / 充值中：只告诉买家充到了哪个账号（掩码），不返回其他信息
    return { state: r.state, email: r.state === 'UNUSED' ? '' : maskEmail(r.email) };
  }),
);

/** 第 3 步：提交充值，返回查询进度用的凭据 */
router.post(
  '/redeem',
  rateLimit('redeem', [
    { scope: 'ip', max: config.antiAbuse.perIpPerMin, windowMs: MIN },
    { scope: 'ip', max: config.antiAbuse.perIpPerHour, windowMs: HOUR },
  ]),
  handle(async (req) => aiaiyg.submit(readCode(req.body.code), readSession(req.body.session))),
);

/** 第 4 步：查询充值进度（页面每几秒轮询一次） */
router.get(
  '/redeem/status',
  rateLimit('redeem-status', [{ scope: 'ip', max: 120, windowMs: MIN }]),
  handle(async (req) => {
    const rid = str(req.query.rid);
    const token = str(req.query.token);
    if (!/^[\w-]{1,128}$/.test(rid) || !/^[\w.-]{1,512}$/.test(token)) throw new HttpError(400, '查询凭据不正确');
    return aiaiyg.progress(rid, token);
  }),
);

/** 邮箱掩码：ab***@gmail.com */
function maskEmail(email: string): string {
  const [name = '', domain = ''] = email.split('@');
  return domain ? `${name.slice(0, 2)}***@${domain}` : '';
}

export default router;
