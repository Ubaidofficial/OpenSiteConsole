/* Refreshes the marketing screenshots in site/assets/shots from the real app on its demo data.
   1. Start the app with DEMO_MODE=1 on http://localhost:5173 (pnpm serve) with a fresh database.
   2. node site/tools/capture-shots.cjs   (connects the demo sources, seeds an SEO test, two indexing checks and a digest, then captures)
   3. python3 site/tools/to-webp.py       (writes the large and 1080 px WebP files into site/assets/shots)
   Each capture hides the app's own header and tab bar and is clipped to whole rows and whole tables, so nothing on the page is cut off.
   To re-capture only some (without seeding again): node site/tools/capture-shots.cjs hidden,tests */
const { chromium } = require('playwright');
const { mkdirSync } = require('node:fs');
const B = process.env.APP_URL || 'http://localhost:5173';
const OUT = 'site/tools/out';
const HIDE = `body > header, footer, nav[aria-label="Site sections"] { display: none !important; } .page-in, .stagger > * { animation: none !important; opacity: 1 !important; transform: none !important; } *{transition:none!important}`;
async function shot(b, name, url, o) {
  const ctx = await b.newContext({ viewport: { width: o.w, height: 1000 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
  if (o.privacy) await ctx.addInitScript(() => localStorage.setItem('osc_privacy', '1'));
  const p = await ctx.newPage();
  await p.goto(B + url, { waitUntil: 'networkidle' });
  if (!o.keepChrome) await p.addStyleTag({ content: HIDE });
  else await p.addStyleTag({ content: '.page-in, .stagger > * { animation: none !important; opacity: 1 !important; transform: none !important; }' });
  if (o.prep) await o.prep(p);
  await p.waitForTimeout(1200);
  const box = await p.evaluate(({ start, end, pad, ratio, maxH, fullX }) => {
    const main = document.querySelector('main');
    const m = main.getBoundingClientRect();
    const cs = getComputedStyle(main);
    const x = fullX ? 0 : m.left + parseFloat(cs.paddingLeft) - pad;
    const w = fullX ? innerWidth : m.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) + 2 * pad;
    const find = (s) => { if (!s) return null; if (s.startsWith('text=')) { const t = s.slice(5); return [...document.querySelectorAll('h1,h2,h3,div,section')].find((e) => e.firstChild && e.innerText && e.innerText.trim().startsWith(t) && e.getBoundingClientRect().height < 80) ; } return document.querySelector(s); };
    const se = find(start); const y = se ? se.getBoundingClientRect().top + scrollY - pad : 0;
    let h;
    if (ratio) h = w / ratio;
    else { const ee = find(end); h = ee.getBoundingClientRect().bottom + scrollY + pad - y; }
    if (maxH) h = Math.min(h, maxH);
    return { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) };
  }, { start: o.start, end: o.end, pad: o.pad ?? 16, ratio: o.ratio, maxH: o.maxH, fullX: o.fullX });
  const need = box.y + box.height;
  await p.setViewportSize({ width: o.w, height: Math.max(1000, Math.ceil(need) + 10) });
  await p.waitForTimeout(400);
  await p.screenshot({ path: `${OUT}/${name}.png`, clip: box });
  console.log(name, box.width + 'x' + box.height);
  await ctx.close();
}
async function seed(b) {
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const connect = async (sel, fill = {}) => {
    await p.goto(B + '/connect', { waitUntil: 'networkidle' });
    const f = p.locator(sel).first();
    if (!(await f.count())) return false;
    for (const [n, v] of Object.entries(fill)) await f.locator('[name=' + n + ']').fill(v);
    await f.locator('button').first().click();
    await p.waitForTimeout(2500);
    return true;
  };
  await connect('form[action="?/bingKey"]', { apiKey: 'demo' });
  await connect('form[action="?/ga4Auto"]');
  await connect('form[action="?/gtmAuto"]');
  await connect('form[action="?/crux"]', { apiKey: 'demo' });
  for (let k = 0; k < 6; k++) if (!(await connect('form[action="?/clarity"]', { token: 'demo' }))) break;
  // a finished SEO test and two indexing checks on coffeelab (site 4), and one weekly digest
  await p.goto(B + '/sites/4/tests', { waitUntil: 'networkidle' });
  const f = p.locator('form[action="?/create"]');
  await f.locator('[name=name]').fill('Rewrote titles and intros on /blog/');
  await f.locator('[name=startDate]').fill(new Date(Date.now() - 45 * 864e5).toISOString().slice(0, 10));
  await f.locator('[name=treatment]').fill('/blog/');
  await f.locator('[name=note]').fill('Shorter titles with the main query first');
  await f.locator('button.btn-primary').click();
  await p.waitForTimeout(3000);
  await p.goto(B + '/sites/4/indexing', { waitUntil: 'networkidle' });
  await p.locator('form[action="?/toggle"] button').click();
  await p.waitForTimeout(1500);
  for (let k = 0; k < 2; k++) { await p.locator('form[action="?/check"] button').click(); await p.waitForTimeout(4000); }
  await p.goto(B + '/digest', { waitUntil: 'networkidle' });
  await p.locator('form[action="?/generate"] button').click();
  await p.waitForTimeout(3000);
  await p.close();
}
(async () => {
  mkdirSync(OUT, { recursive: true });
  const b = await chromium.launch();
  const only = process.argv[2] ? process.argv[2].split(',') : null;
  if (!only) await seed(b);
  const S = {
    dashboard: ['/', { w: 1440, keepChrome: true, fullX: false, end: 'main article:nth-of-type(4)', pad: 16, start: null }],
    privacy: ['/', { w: 1100, privacy: true, start: 'main .stagger', ratio: 1.6 }],
    actions: ['/actions', { w: 960, start: 'main h1', ratio: 1.6 }],
    portfolio: ['/portfolio', { w: 960, start: 'main h1', ratio: 1.6 }],
    pages: ['/sites/1/pages', { w: 1900, start: '.page-in', ratio: 1.6, prep: async (p) => { await p.addStyleTag({ content: 'main{max-width:none!important}' }); } }],
    opportunities: ['/sites/1/opportunities', { w: 960, start: '.page-in', ratio: 1.6 }],
    tests: ['/sites/4/tests', { w: 1200, start: 'text=Rewrote titles', ratio: 1.6, prep: async (p) => { await p.addStyleTag({ content: 'form[action="?/create"]{display:none!important}' }); } }],
    indexing: ['/sites/4/indexing', { w: 960, start: '.page-in', ratio: 1.6 }],
    hidden: ['/sites/1/opportunities', { w: 1240, start: 'text=Hidden opportunities', end: 'section.mb-6:last-of-type', pad: 20, prep: async (p) => { await p.evaluate(() => {
  const secs = [...document.querySelectorAll('section.mb-6')];
  secs.forEach((s) => { const t = s.querySelector('h3').innerText; if (/\s0\s*$/.test(t.trim()) || /Questions/.test(t)) s.remove(); });
  const edge = [...document.querySelectorAll('section.mb-6')].find((s) => /Pages on the edge/.test(s.innerText));
  if (edge) { edge.querySelectorAll('tbody tr').forEach((tr, i) => { if (i >= 6) tr.remove(); }); edge.querySelectorAll('.mt-3.flex').forEach((e)=>e.remove()); }
  const h = document.querySelector('h3'); });
  await p.addStyleTag({ content: 'section.mb-6:last-of-type{margin-bottom:0!important}' }); } }],
    digest: ['/digest', { w: 960, start: 'main h1', ratio: 1.6 }],
    vitals: ['/sites/1/vitals', { w: 960, start: '.page-in', ratio: 1.6 }],
    sitemaps: ['/sites/4/indexing', { w: 960, start: 'text=Sitemap coverage', ratio: 1.6 }],
  };
  for (const [n, [u, o]] of Object.entries(S)) { if (only && !only.includes(n)) continue; await shot(b, n, u, o); }
  await b.close();
})();
