/* SEOConsole marketing site: scroll-driven motion. No libraries, no network requests.
   Everything is progressive: without JavaScript the page is complete and static, and with
   prefers-reduced-motion nothing moves (the CSS shows every final state). */
(() => {
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* header state, and the hero product tilting flat as you scroll */
  const top = $('.top'), stage = $('[data-stage]');
  let ticking = false;
  function onScroll() {
    ticking = false;
    const y = scrollY;
    top.classList.toggle('scrolled', y > 8);
    if (stage && !still) {
      const r = stage.getBoundingClientRect();
      const p = clamp((innerHeight * 0.9 - r.top) / (innerHeight * 0.9 - 64), 0, 1);
      stage.style.setProperty('--p', p.toFixed(3));
    } else if (stage) stage.style.setProperty('--p', '1');
  }
  addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(onScroll); } }, { passive: true });
  addEventListener('resize', onScroll);
  onScroll();

  /* blur-in headings (after Shadcn Space's text reveal, MIT): split each section heading into words before the reveal
     observer below sees it, so the words fade in one after another. Screen readers still get the plain heading text. */
  if (!still) $$('h2.rv').forEach((h) => {
    if (h.children.length) return; // only plain-text headings
    const words = h.textContent.trim().split(/\s+/);
    h.setAttribute('aria-label', words.join(' '));
    h.textContent = '';
    words.forEach((w, i) => {
      const s = document.createElement('span');
      s.className = 'wd';
      s.setAttribute('aria-hidden', 'true');
      s.style.setProperty('--wi', String(i));
      s.textContent = w;
      h.append(s, i < words.length - 1 ? ' ' : '');
    });
    h.classList.add('words');
  });

  /* reveal on scroll, staggered among siblings */
  const reveals = $$('.rv');
  const seen = new Map();
  reveals.forEach((el) => { const n = seen.get(el.parentElement) ?? 0; seen.set(el.parentElement, n + 1); el.style.setProperty('--d', Math.min(n, 6) * 0.07 + 's'); });
  if (still || !('IntersectionObserver' in window)) reveals.forEach((el) => el.classList.add('in'));
  else {
    const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
    reveals.forEach((el) => io.observe(el));
  }

  /* the data-flow beam only animates while it is on screen */
  const beam = $('[data-beam]');
  /* The lines are written in percent (a 0-100 box). Redraw them in real pixels so each pulse is one even segment:
     a stretched SVG would distort the stroke and break the dash lengths. */
  const bsvg = beam && $('.beam-svg', beam);
  if (bsvg) {
    const paths = $$('path', bsvg);
    paths.forEach((pa) => { pa.dataset.d = pa.getAttribute('d'); });
    const draw = () => {
      const w = bsvg.clientWidth, h = bsvg.clientHeight;
      if (!w || !h) return;
      bsvg.setAttribute('viewBox', `0 0 ${w} ${h}`);
      paths.forEach((pa) => {
        let k = 0;
        pa.setAttribute('d', pa.dataset.d.replace(/-?\d*\.?\d+/g, (n) => ((k++ % 2 ? h : w) * Number(n) / 100).toFixed(1)));
      });
    };
    draw();
    addEventListener('resize', draw);
  }
  if (beam && 'IntersectionObserver' in window) new IntersectionObserver((es) => es.forEach((e) => beam.classList.toggle('on', e.isIntersecting))).observe(beam);
  else if (beam) beam.classList.add('on');

  /* animated list (after Shadcn Space, MIT): the digest's alerts drop in at the top one by one, once, when the card is in view.
     The list is written in its final order, so the last item arrives first and each newer one pushes the others down. */
  const alist = $('[data-alist]');
  if (alist && !still && 'IntersectionObserver' in window) {
    const items = $$('li', alist).reverse();
    alist.style.setProperty('min-height', alist.offsetHeight + 'px'); // keep the final height, so nothing below moves while the list fills (no layout shift)
    alist.classList.add('live');
    new IntersectionObserver((es, ob) => es.forEach(async (e) => {
      if (!e.isIntersecting) return;
      ob.disconnect();
      for (const li of items) { li.classList.add('show'); await sleep(850); }
      alist.style.removeProperty('min-height'); // full again: let it follow the card's width from here on
    }), { threshold: 0.4 }).observe(alist);
  }

  /* privacy mode on the portfolio card: a real switch, and it shows itself once when the card first comes into view */
  $$('[data-pf]').forEach((pf) => {
    const sw = $('[data-privacy]', pf);
    const set = (on) => { pf.classList.toggle('priv', on); sw.setAttribute('aria-pressed', String(on)); };
    sw.addEventListener('click', () => { pf.dataset.touched = '1'; set(sw.getAttribute('aria-pressed') !== 'true'); });
    if (still || !('IntersectionObserver' in window)) return;
    new IntersectionObserver(async (es, ob) => {
      if (!es.some((e) => e.isIntersecting)) return;
      ob.disconnect();
      await sleep(2200); if (pf.dataset.touched) return; set(true);
      await sleep(2200); if (pf.dataset.touched) return; set(false);
    }, { threshold: 0.5 }).observe(pf);
  });

  /* pinned story: the screenshot on the right follows the step in the middle of the screen */
  const steps = $$('.step'), frames = $$('.frame'), dots = $$('.dots li');
  const labels = ['Overview', 'Portfolio', 'Pages', 'Opportunities', 'Tests', 'Indexing'];
  const pinUrl = $('[data-pin-url]');
  function setActive(i) {
    steps.forEach((s, k) => s.classList.toggle('on', k === i));
    frames.forEach((f, k) => f.classList.toggle('on', k === i));
    dots.forEach((d, k) => d.classList.toggle('on', k === i));
    if (pinUrl) pinUrl.textContent = labels[i] + ' · demo data';
  }
  if (steps.length && 'IntersectionObserver' in window) {
    const so = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) setActive(Number(e.target.dataset.i)); }), { rootMargin: '-45% 0px -45% 0px' });
    steps.forEach((s) => so.observe(s));
    setActive(0);
  }

  /* the agent terminal types itself once, when it scrolls into view */
  const term = $('[data-term]');
  if (term && !still && 'IntersectionObserver' in window) {
    const lines = $$('.t-line', term);
    term.classList.add('live');
    let started = false;
    async function typeInto(line) {
      const node = [...line.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim());
      if (!node) { line.classList.add('show'); return; }
      const full = node.textContent;
      node.textContent = '';
      line.classList.add('show');
      const caret = document.createElement('span');
      caret.className = 'caret';
      line.appendChild(caret);
      for (const ch of full) { node.textContent += ch; await sleep(16 + Math.random() * 20); }
      caret.remove();
    }
    async function play() {
      for (const line of lines) {
        const kind = line.dataset.step;
        if (kind === 'user') { await sleep(500); await typeInto(line); await sleep(420); }
        else if (kind === 'tool') { line.classList.add('show'); await sleep(900); }
        else if (kind === 'ok') { line.classList.add('show'); await sleep(520); }
        else if (kind === 'say') { line.classList.add('show'); await sleep(900); }
        else { line.classList.add('show'); await sleep(420); }
      }
    }
    new IntersectionObserver((es, ob) => es.forEach((e) => { if (e.isIntersecting && !started) { started = true; ob.disconnect(); play(); } }), { threshold: 0.35 }).observe(term);
  }

  /* count-up for numbers marked data-count (written in full in the HTML, so they are right without JavaScript) */
  const nf = new Intl.NumberFormat('en-US');
  $$('[data-count]').forEach((el) => {
    const to = Number(el.dataset.count);
    if (still || !('IntersectionObserver' in window)) return;
    new IntersectionObserver((es, ob) => es.forEach((e) => {
      if (!e.isIntersecting) return;
      ob.disconnect();
      const t0 = performance.now();
      const tick = (t) => { const k = clamp((t - t0) / 1300, 0, 1); el.textContent = nf.format(Math.round(to * (1 - Math.pow(2, -10 * k)))); if (k < 1) requestAnimationFrame(tick); else el.textContent = nf.format(to); };
      requestAnimationFrame(tick);
    }), { threshold: 0.6 }).observe(el);
  });

  /* connect tabs, with arrow-key support */
  $$('[data-tabs]').forEach((box) => {
    const tabs = $$('[role=tab]', box), panels = tabs.map((t) => $('#' + t.getAttribute('aria-controls')));
    const select = (i, focus) => {
      tabs.forEach((t, k) => { const on = k === i; t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; panels[k].hidden = !on; });
      if (focus) tabs[i].focus();
    };
    tabs.forEach((t, i) => {
      t.addEventListener('click', () => select(i));
      t.addEventListener('keydown', (e) => {
        const k = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
        if (k === undefined) return;
        e.preventDefault();
        select((k + tabs.length) % tabs.length, true);
      });
    });
  });

  /* copy buttons */
  $$('.copy').forEach((btn) => btn.addEventListener('click', async () => {
    const text = btn.dataset.copy;
    try { await navigator.clipboard.writeText(text); }
    catch {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch { /* the text stays visible to copy by hand */ }
      ta.parentNode.removeChild(ta);
    }
    btn.textContent = 'Copied';
    btn.classList.add('ok');
    setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('ok'); }, 1600);
  }));

  /* cursor-following highlight on the feature cards */
  if (!still) $$('.card, .win').forEach((c) => c.addEventListener('pointermove', (e) => {
    const r = c.getBoundingClientRect();
    c.style.setProperty('--mx', e.clientX - r.left + 'px');
    c.style.setProperty('--my', e.clientY - r.top + 'px');
  }));
})();
