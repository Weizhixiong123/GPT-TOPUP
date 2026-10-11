// 滑动窗口限流（单进程内存）。多实例部署时应换成 Redis 实现。
import type { RequestHandler } from 'express';

export interface RateRule {
  max: number;
  windowMs: number;
  /** ip：按客户端 IP 计数；global：全站共用一个计数 */
  scope: 'ip' | 'global';
}

type Store = Map<string, number[]>; // key -> 时间戳数组
const buckets: Store = new Map();
// 登录失败记录单独存放：普通接口被大量 IP 刷满时，不能把后台登录的封禁记录一起挤掉
const failures: Store = new Map();
// 防止大量不同 IP 撑爆内存：超过上限时淘汰最早写入的记录（宁可短暂放宽限流，也不能让进程 OOM）
const MAX_KEYS = 200_000;

/**
 * 限流用的客户端标识。
 * IPv6 按 /64 前缀归并：一个用户通常拿到整个 /64 段，按完整地址计数等于没有限制。
 */
export function ipKey(ip: string | undefined): string {
  if (!ip) return '';
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped?.[1]) return mapped[1];
  if (!ip.includes(':')) return ip;
  const [head = '', tail] = (ip.split('%')[0] ?? '').toLowerCase().split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

function recent(map: Store, key: string, windowMs: number): number[] {
  const t = Date.now();
  return (map.get(key) ?? []).filter((x) => t - x < windowMs);
}

function store(map: Store, key: string, arr: number[]): void {
  if (!map.has(key) && map.size >= MAX_KEYS) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, arr);
}

/** 记录一次访问；超限时返回需要等待的秒数，否则返回 0 */
function hit(key: string, max: number, windowMs: number): number {
  const t = Date.now();
  const arr = recent(buckets, key, windowMs);
  if (arr.length >= max) {
    store(buckets, key, arr);
    return Math.ceil(((arr[0] ?? t) + windowMs - t) / 1000);
  }
  arr.push(t);
  store(buckets, key, arr);
  return 0;
}

/**
 * 失败计数器：只统计失败次数（如后台密码错误），达到上限后在窗口期内直接拒绝。
 * 与 rateLimit 不同，成功的请求不计数。
 */
export function failureGuard(name: string, max: number, windowMs: number) {
  const key = (ip: string) => `${name}:${ipKey(ip)}:${windowMs}`;
  return {
    /** 已被封禁时返回剩余秒数，否则 0 */
    blocked(ip: string): number {
      const arr = recent(failures, key(ip), windowMs);
      return arr.length >= max ? Math.ceil(((arr[0] ?? Date.now()) + windowMs - Date.now()) / 1000) : 0;
    },
    fail(ip: string): void {
      const arr = recent(failures, key(ip), windowMs);
      arr.push(Date.now());
      store(failures, key(ip), arr);
    },
  };
}

/** 任意一条规则超限即拒绝 */
export function rateLimit(name: string, rules: RateRule[], message = '操作太频繁，请稍后再试'): RequestHandler {
  return (req, res, next) => {
    for (const r of rules) {
      const key = `${name}:${r.scope === 'global' ? '*' : ipKey(req.ip)}:${r.windowMs}`;
      const retry = hit(key, r.max, r.windowMs);
      if (retry) {
        res.set('Retry-After', String(retry));
        res.status(429).json({ error: r.scope === 'global' ? '当前下单人数较多，请稍后再试' : message });
        return;
      }
    }
    next();
  };
}

// 定期清理过期记录，防止内存增长
setInterval(() => {
  const t = Date.now();
  for (const map of [buckets, failures]) {
    for (const [k, arr] of map) {
      const windowMs = Number(k.slice(k.lastIndexOf(':') + 1));
      const last = arr[arr.length - 1];
      if (last === undefined || t - last > windowMs) map.delete(k);
    }
  }
}, 60e3).unref();
