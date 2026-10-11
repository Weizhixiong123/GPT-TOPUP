// 联系客服：右下角悬浮按钮，点击后从右侧滑出小窗。首页 / 我的订单 / 订单页共用。
// 联系方式由服务端 /api/support 提供（在 .env 的 SUPPORT_* 中配置），这里只负责展示。
(() => {
  const ICON_CHAT = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.3 8.7 8.7 0 0 1-3.6-.8L3 21l1.9-5.1A8.1 8.1 0 0 1 4 11.5 8.4 8.4 0 0 1 12.5 3 8.4 8.4 0 0 1 21 11.5z"/><path d="M8.5 11.5h.01M12.5 11.5h.01M16.5 11.5h.01"/></svg>';
  const ICON_CLOSE = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

  /** 创建元素；文字一律走 textContent，不拼 HTML */
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  async function copy(text, btn) {
    const old = btn.textContent;
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = '已复制';
    } catch {
      btn.textContent = '请手动复制';
    }
    setTimeout(() => (btn.textContent = old), 1500);
  }

  /** 一行联系方式：名称 + 内容 + 复制按钮（或跳转链接） */
  function row(label, value, href) {
    const r = el('div', 'sp-row');
    const main = el('div', 'sp-main');
    main.append(el('span', 'sp-label', label), el('b', 'sp-value', value));
    r.append(main);
    if (href) {
      const a = el('a', 'sp-act', '打开');
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      r.append(a);
    } else {
      const b = el('button', 'sp-act', '复制');
      b.type = 'button';
      b.onclick = () => copy(value, b);
      r.append(b);
    }
    return r;
  }

  const fab = el('button', 'sp-fab');
  fab.type = 'button';
  fab.innerHTML = ICON_CHAT;
  fab.append(el('span', '', '联系客服'));
  fab.setAttribute('aria-haspopup', 'dialog');
  fab.setAttribute('aria-expanded', 'false');

  const mask = el('div', 'sp-mask');
  const panel = el('aside', 'sp-panel');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', '联系客服');
  panel.setAttribute('aria-hidden', 'true');
  panel.inert = true;

  const head = el('div', 'sp-head');
  const close = el('button', 'sp-close');
  close.type = 'button';
  close.innerHTML = ICON_CLOSE;
  close.setAttribute('aria-label', '关闭');
  head.append(el('h2', '', '联系客服'), close);
  // 由页面传入的提示（如从套餐按钮打开时，告诉用户加客服后说什么）
  const tip = el('p', 'sp-tip');
  tip.hidden = true;
  const body = el('div', 'sp-body');
  body.append(el('p', 'muted', '加载中…'));
  panel.append(head, tip, body);
  document.body.append(fab, mask, panel);

  let loaded = false;
  async function load() {
    if (loaded) return;
    let cfg;
    try {
      const r = await fetch('/api/support');
      cfg = await r.json();
      if (!r.ok) throw new Error(cfg.error);
    } catch {
      body.replaceChildren(el('p', 'muted', '客服信息加载失败，请稍后再试'));
      return;
    }
    loaded = true;
    body.replaceChildren();

    if (cfg.hours) body.append(el('p', 'sp-hours', `服务时间：${cfg.hours}`));

    // 在订单页打开时带上订单号，方便用户直接发给客服
    const orderNo = new URLSearchParams(location.search).get('no');
    if (orderNo && /^T\d{20}$/.test(orderNo)) {
      const box = el('div', 'sp-order');
      box.append(el('div', 'muted', '联系客服时请提供订单号'), row('订单号', orderNo));
      body.append(box);
    }

    const list = el('div', 'sp-list');
    if (cfg.wechat) list.append(row('微信', cfg.wechat));
    if (cfg.qq) list.append(row('QQ', cfg.qq));
    if (cfg.telegram) list.append(row('Telegram', `@${cfg.telegram}`, `https://t.me/${encodeURIComponent(cfg.telegram)}`));
    if (cfg.email) list.append(row('邮箱', cfg.email));
    if (list.children.length) body.append(list);

    if (cfg.qr) {
      const fig = el('figure', 'sp-qr');
      const img = el('img');
      img.src = cfg.qr;
      img.alt = '客服二维码';
      img.loading = 'lazy';
      // 图片加载不出来（路径配错、文件没放）时整块隐藏，不显示破图
      img.onerror = () => fig.remove();
      fig.append(img, el('figcaption', 'muted', '扫码添加客服'));
      body.append(fig);
    }

    if (!list.children.length && !cfg.qr) body.append(el('p', 'muted', '暂未配置客服联系方式'));
    if (cfg.note) body.append(el('p', 'sp-note muted', cfg.note));
  }

  function toggle(open, hint = '') {
    if (open) {
      tip.textContent = hint;
      tip.hidden = !hint;
    }
    panel.classList.toggle('open', open);
    mask.classList.toggle('open', open);
    panel.setAttribute('aria-hidden', String(!open));
    panel.inert = !open;
    fab.setAttribute('aria-expanded', String(open));
    if (open) {
      void load();
      close.focus();
    } else {
      fab.focus();
    }
  }

  // 供页面主动打开小窗（订单页在需要用户联系客服时调用）
  // 可带一句提示文字，显示在小窗顶部
  window.openSupport = (hint) => toggle(true, typeof hint === 'string' ? hint : '');

  fab.onclick = () => toggle(!panel.classList.contains('open'));
  close.onclick = () => toggle(false);
  mask.onclick = () => toggle(false);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panel.classList.contains('open')) toggle(false);
  });
})();
