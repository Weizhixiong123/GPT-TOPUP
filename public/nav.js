// 页面切换器：在「套餐」和「我的订单」之间切换时不重新加载整个网页，只替换中间的内容。
//
// 这两个页面仍然是各自独立、完整的网页：直接打开网址、刷新、搜索引擎抓取都和以前一样。
// 只有在站内点击链接时才走这里：把目标页面取回来，换掉内容区、导航和页脚，再启动那个页面的脚本。
// 订单详情页不在其列（它涉及付款和轮询，保持整页加载）。
//
// 页面脚本的写法：
//   definePage('/orders.html', (page) => { ... });
// 进入页面时调用这个函数；离开时，通过 page.on / page.timeout 注册的监听和定时器会被自动清掉。
(() => {
  const PAGES = new Set(['/', '/orders.html']);
  const norm = (p) => (p === '/index.html' ? '/' : p);
  /** 取回的页面多久之内可以直接用。首页带库存状态，不宜放太久；下单时服务端还会再校验 */
  const FRESH_MS = 15_000;

  const inits = new Map(); // 路径 -> 页面的启动函数
  const cache = new Map(); // 路径 -> { at, html, pending }
  let current = null;

  function makePage(path, ready, soft) {
    const page = {
      path,
      /** 用户是否还停留在这个页面。异步操作（如接口请求）返回后要先看这个，再去改页面 */
      alive: true,
      /** 是不是通过站内切换进来的（而不是整页加载） */
      soft,
      /** 进入页面的过渡动画结束时完成。想避免内容在淡入途中被换掉，就等它 */
      ready,
      cleanups: [],
      on(target, type, fn, opts) {
        target.addEventListener(type, fn, opts);
        page.cleanups.push(() => target.removeEventListener(type, fn, opts));
      },
      timeout(fn, ms) {
        const id = setTimeout(() => page.alive && fn(), ms);
        page.cleanups.push(() => clearTimeout(id));
        return id;
      },
    };
    return page;
  }

  function leave() {
    if (!current) return;
    current.alive = false;
    for (const fn of current.cleanups.splice(0)) {
      try { fn(); } catch {}
    }
  }

  function enter(path, ready, soft) {
    leave();
    current = makePage(path, ready, soft);
    inits.get(path)?.(current);
  }

  window.definePage = (path, init) => {
    inits.set(path, init);
    // 整页加载进来的那个页面：定义完立刻启动
    if (!current && norm(location.pathname) === path) enter(path, window.pageReady ?? Promise.resolve(), false);
  };

  // ---------- 取回页面 ----------
  function fetchPage(path) {
    const hit = cache.get(path);
    if (hit?.pending) return hit.pending;
    const pending = fetch(path, { credentials: 'same-origin' })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((html) => {
        cache.set(path, { at: Date.now(), html });
        return html;
      })
      .catch((e) => {
        cache.delete(path);
        throw e;
      });
    cache.set(path, { ...hit, pending });
    return pending;
  }
  function getPage(path) {
    const hit = cache.get(path);
    return hit?.html && Date.now() - hit.at < FRESH_MS ? Promise.resolve(hit.html) : fetchPage(path);
  }
  /** 提前取回，让点击时可以立刻切换。已有且还新鲜的就不重复取 */
  function warm(path) {
    const hit = cache.get(path);
    if (hit?.pending || (hit?.html && Date.now() - hit.at < FRESH_MS / 2)) return;
    fetchPage(path).catch(() => {});
  }

  // ---------- 切换 ----------
  let navId = 0;
  async function go(url, { push = true } = {}) {
    const path = norm(url.pathname);
    const id = ++navId;
    let html;
    try {
      html = await getPage(path);
    } catch {
      // 取不回来就退回普通的整页跳转
      location.href = url.href;
      return;
    }
    // 等待期间用户又点了别处：以最后一次为准
    if (id !== navId) return;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    if (!doc.querySelector('main')) {
      location.href = url.href;
      return;
    }

    let done;
    const ready = new Promise((r) => (done = r));

    const swap = () => {
      leave();
      document.title = doc.title;

      // 每个页面在 head 里有一段自己的样式：换上新页面的，去掉旧页面的
      const oldStyle = document.head.querySelector('style[data-page]');
      const newStyle = doc.head.querySelector('style[data-page]');
      if (newStyle) document.head.appendChild(document.importNode(newStyle, true));
      oldStyle?.remove();

      // 导航（当前项不同）、内容区、页脚
      for (const sel of ['.topnav nav', 'main', 'body > footer']) {
        const from = document.querySelector(sel);
        const to = doc.querySelector(sel);
        if (from && to) from.replaceWith(document.importNode(to, true));
      }
      // 服务端随页面给出的数据（如首页的套餐和支付方式）
      for (const data of doc.querySelectorAll('script[type="application/json"][id]')) {
        document.getElementById(data.id)?.remove();
        document.body.appendChild(document.importNode(data, true));
      }

      if (push) history.pushState(null, '', url.href);

      // 这个页面的脚本还没加载过：把它放进文档执行一次，它会调用 definePage 登记启动函数
      if (!inits.has(path)) {
        for (const s of doc.querySelectorAll('script[data-page]')) {
          const el = document.createElement('script');
          el.dataset.page = '';
          el.textContent = s.textContent;
          document.body.appendChild(el);
        }
      }

      scrollTo(0, 0);
      syncNavState();
      enter(path, ready, true);

      // 带锚点的链接（如从「我的订单」点「常见问题」）：切到首页后滚到对应位置
      if (url.hash) {
        try { document.querySelector(url.hash)?.scrollIntoView({ block: 'start' }); } catch {}
      }
    };

    // 和整页跳转用同一套过渡样式（见 style.css「页面之间的切换」）；不支持的浏览器直接替换，
    // 新内容本身带有出场动画，同样不会显得突兀
    if (document.startViewTransition) {
      const t = document.startViewTransition(swap);
      t.finished.then(done, done);
    } else {
      swap();
      done();
    }
  }

  const isSoftLink = (url) => url.origin === location.origin && PAGES.has(norm(url.pathname));

  document.addEventListener('click', (e) => {
    // 页面脚本自己处理过的点击（如首页的页内锚点）、新窗口打开、带修饰键的点击，都不管
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest?.('a[href]');
    if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
    const url = new URL(a.href, location.href);
    if (!current || !isSoftLink(url)) return;
    if (norm(url.pathname) === current.path) {
      // 就是当前页：不重新加载，回到顶部即可（带锚点的交给浏览器默认行为）
      if (!url.hash) {
        e.preventDefault();
        scrollTo({ top: 0, behavior: 'smooth' });
      }
      return;
    }
    e.preventDefault();
    go(url);
  });

  // 浏览器的前进 / 后退
  addEventListener('popstate', () => {
    const path = norm(location.pathname);
    if (current && PAGES.has(path) && path !== current.path) go(new URL(location.href), { push: false });
  });

  // 鼠标移上去或手指按下时就开始取，点下去时多半已经取回来了
  for (const type of ['pointerover', 'touchstart', 'focusin']) {
    document.addEventListener(
      type,
      (e) => {
        const a = e.target.closest?.('a[href]');
        if (!a) return;
        const url = new URL(a.href, location.href);
        if (current && isSoftLink(url) && norm(url.pathname) !== current.path) warm(norm(url.pathname));
      },
      { capture: true, passive: true },
    );
  }
  // 页面空闲后把另一个页面也取回来备用
  const idle = window.requestIdleCallback ?? ((fn) => setTimeout(fn, 800));
  addEventListener('load', () => idle(() => { for (const p of PAGES) if (current && p !== current.path) warm(p); }));

  // 导航栏在页面滚动后加上底色，两个页面通用
  function syncNavState() {
    document.getElementById('topnav')?.classList.toggle('scrolled', scrollY > 8);
  }
  addEventListener('scroll', syncNavState, { passive: true });
})();
