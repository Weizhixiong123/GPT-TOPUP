// 首页（卡密兑换页）由服务端输出：public/index.html 是模板，<!--HEAD--> 占位符在这里替换成按站点地址生成的标签。
import fs from 'node:fs';
import path from 'node:path';
import config from './config.ts';

const TEMPLATE = path.join(config.publicDir, 'index.html');
let cachedTemplate: string | undefined;
/** 生产环境只读一次；开发时每次都读，改了页面刷新就能看到 */
const template = (): string => (config.isProd ? (cachedTemplate ??= fs.readFileSync(TEMPLATE, 'utf8')) : fs.readFileSync(TEMPLATE, 'utf8'));

const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

export function renderHome(): string {
  const base = config.baseUrl.replace(/\/$/, '');
  const head = [
    `<link rel="canonical" href="${esc(base)}/">`,
    `<meta property="og:url" content="${esc(base)}/">`,
    `<meta property="og:image" content="${esc(base)}/brand/share.png">`,
  ].join('\n  ');
  // 用函数做替换：内容里若有 $& 之类的字符，不会被当成替换模式
  return template().replace('<!--HEAD-->', () => head);
}

export function robotsTxt(): string {
  return [
    'User-agent: *',
    // 接口不需要被收录
    'Disallow: /api/',
    '',
    `Sitemap: ${config.baseUrl.replace(/\/$/, '')}/sitemap.xml`,
    '',
  ].join('\n');
}

export function sitemapXml(): string {
  const base = config.baseUrl.replace(/\/$/, '');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${esc(base)}/</loc></url>
</urlset>
`;
}
