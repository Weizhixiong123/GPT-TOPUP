// 首页由服务端直接输出套餐内容：不执行脚本的爬虫（百度、必应、各类分享预览）也能看到套餐和价格。
// public/index.html 是模板，里面的 <!--XXX--> 占位符在这里替换；页面上的脚本只负责绑定点击事件。
import fs from 'node:fs';
import path from 'node:path';
import config from './config.ts';
import * as payments from './payments/index.ts';
import type { listPlans } from './services/orders.ts';

type HomePlan = Awaited<ReturnType<typeof listPlans>>[number];

const TEMPLATE = path.join(config.publicDir, 'index.html');
let cachedTemplate: string | undefined;
/** 生产环境只读一次；开发时每次都读，改了页面刷新就能看到 */
const template = (): string => (config.isProd ? (cachedTemplate ??= fs.readFileSync(TEMPLATE, 'utf8')) : fs.readFileSync(TEMPLATE, 'utf8'));

const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
const yuan = (cents: number): string => (cents / 100).toFixed(2).replace(/\.00$/, '');
/** 放进 <script> 里的 JSON：转义 <，防止内容里出现 </script> 把标签提前闭合 */
const jsonForScript = (v: unknown): string => JSON.stringify(v).replace(/</g, '\\u003c');

const CHECK =
  '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 10.5l4 4 8-9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/** 「ChatGPT Pro 5x 1个月」→ 短标题 / 月数 / 卖点 */
function parsePlan(p: HomePlan): { short: string; months: string; features: string[] } {
  const short = p.name.replace(/^ChatGPT\s*/i, '').replace(/\s*\d+\s*个?月$/, '') || p.name;
  const months = /(\d+)\s*个?月$/.exec(p.name)?.[1] ?? '1';
  const mult = /(\d+)\s*x/i.exec(short)?.[1];
  return {
    short,
    months,
    features: [
      mult ? `用量为 Plus 的 ${mult} 倍` : `${short} 基础用量`,
      `有效期 ${months} 个月`,
      p.manual ? '专人充值，客服一对一服务' : '自动充值，通常 1 分钟到账',
    ],
  };
}

function planCard(p: HomePlan, featured: boolean): string {
  const { short, months, features } = parsePlan(p);
  // 人工服务套餐不看库存
  const available = p.manual || p.in_stock;
  const label = p.manual ? '联系客服购买' : p.in_stock ? `选择 ${esc(short)}` : '暂时缺货';
  return `
    <div class="plan${featured ? ' featured' : ''}" data-id="${p.id}" data-short="${esc(short)}">
      <h2 class="title">${esc(short)}</h2>
      <div class="price"><span class="cur">¥</span><span class="num">${yuan(p.price_cents)}</span><span class="per">/ ${months === '1' ? '' : months}月</span></div>
      <div class="tagline">${esc(p.description)}</div>
      <ul>${features.map((f) => `<li>${CHECK}<span>${esc(f)}</span></li>`).join('')}</ul>
      <button class="buy" type="button"${available ? '' : ' disabled'}>${label}</button>
    </div>`;
}

// 自助下单和人工购买是两套不同的步骤，照实写
const STEPS: Record<'self' | 'manual', [title: string, desc: string][]> = {
  self: [['选择套餐', '挑一个适合你的'], ['扫码付款', '微信或支付宝'], ['提交登录信息', '按订单页的提示粘贴'], ['自动到账', '订单页实时显示进度']],
  manual: [['选择套餐', '挑一个适合你的'], ['联系客服', '添加客服并说明套餐'], ['付款并提供账号', '按客服的指引操作'], ['专人充值', '完成后客服通知你']],
};

/** 结构化数据：套餐名称和价格，供搜索引擎准确识别 */
function jsonLd(plans: HomePlan[], url: string): string {
  return jsonForScript({
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: 'ChatGPT 会员充值套餐',
    itemListElement: plans.map((p, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      item: {
        '@type': 'Product',
        name: p.name,
        ...(p.description ? { description: p.description } : {}),
        offers: {
          '@type': 'Offer',
          url,
          price: (p.price_cents / 100).toFixed(2),
          priceCurrency: 'CNY',
          availability: `https://schema.org/${p.manual || p.in_stock ? 'InStock' : 'OutOfStock'}`,
        },
      },
    })),
  });
}

export async function renderHome(getPlans: () => Promise<HomePlan[]>): Promise<string> {
  let plans: HomePlan[] = [];
  let failed = false;
  try {
    plans = await getPlans();
  } catch (e) {
    // 数据库暂时不可用时页面照样能打开，只是套餐区域给出提示
    failed = true;
    console.error('[home] 读取套餐失败', e);
  }
  const channels = payments.list();
  const manualOnly = channels.length === 0;
  const base = config.baseUrl.replace(/\/$/, '');
  const featuredId = (plans.find((p) => /5x/i.test(p.name)) ?? plans[Math.floor(plans.length / 2)])?.id;

  const parts: Record<string, string> = {
    HEAD: [
      `<link rel="canonical" href="${esc(base)}/">`,
      `<meta property="og:url" content="${esc(base)}/">`,
      `<meta property="og:image" content="${esc(base)}/brand/share.png">`,
      plans.length ? `<script type="application/ld+json">${jsonLd(plans, `${base}/`)}</script>` : '',
    ].join('\n  '),
    HERO_SUB: manualOnly ? '选好套餐，联系客服即可开通，由专人为你充值' : '选好套餐，扫码付款后自动充值到你的账号',
    PLANS: failed
      ? '<p class="muted">套餐加载失败，请稍后刷新重试</p>'
      : plans.length
        ? plans.map((p) => planCard(p, p.id === featuredId)).join('')
        : '<p class="muted">暂无可售套餐</p>',
    STEPS: STEPS[manualOnly ? 'manual' : 'self']
      .map(([title, desc], i) => `<div class="s"><div class="n">${i + 1}</div><div><b>${title}</b><span>${desc}</span></div></div>`)
      .join(''),
    DATA: jsonForScript({ plans, channels }),
  };
  // 用函数做替换：内容里若有 $& 之类的字符，不会被当成替换模式
  return template().replace(/<!--(HEAD|HERO_SUB|PLANS|STEPS|DATA)-->/g, (_m, key: string) => parts[key] ?? '');
}

export function robotsTxt(): string {
  return [
    'User-agent: *',
    // 订单页的网址里带访问密钥，后台和接口也不需要被收录
    'Disallow: /api/',
    'Disallow: /admin.html',
    'Disallow: /order.html',
    'Disallow: /orders.html',
    'Disallow: /mock-pay/',
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
