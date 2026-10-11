import crypto from 'node:crypto';
import config from './config.ts';

const key = Buffer.from(config.tokenSecret, 'hex');

/** AES-256-GCM 加密用户 Token，数据库中不落明文 */
export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}

export function decrypt(enc: string): string {
  const [iv, tag, data] = enc.split('.').map((s) => Buffer.from(s, 'base64'));
  if (!iv || !tag || !data) throw new Error('密文格式错误');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

export function mask(s: string): string {
  if (s.length <= 12) return '*'.repeat(s.length);
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

export const randomId = (bytes = 16): string => crypto.randomBytes(bytes).toString('hex');

export function orderNo(): string {
  const d = new Date();
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  return `T${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${crypto.randomInt(100000, 999999)}`;
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
