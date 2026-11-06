import { describe, expect, it } from 'vitest';
import { BANDS, bandOf, computeMovers, isQuestionQuery, newAndLost, positionBands, projectClicks, theilSen, trajectoryOf, weeklyTotals } from '../src/lib/trends';
import { buildHeatmap, completeMonths, countryCannibalization, groupPages, localeOf, localeReport, queryTokens, topicClusters, urlSection } from '../src/lib/groups';
import { dispersion, indexSeries, liftTest, normalCdf, parseScope, pickControl, scopeMatcher } from '../src/lib/experiments';
import { classifyUrl, diffInspection, indexState } from '../src/lib/indexing';
import { checkPage, matchQuery, onPageScore, parseOnPage } from '../src/lib/onpage';
import { DEFAULT_CTR, fitCtrCurve } from '../src/lib/analytics';

const m = (clicks: number, impressions = clicks * 20, position = 5) => ({ clicks, impressions, position });
const k = (key: string, clicks: number, impressions = clicks * 20, position = 5) => ({ key, ...m(clicks, impressions, position) });
const curve = fitCtrCurve([]); // default curve

describe('movers, new and lost queries, bands', () => {
	it('flags real movement and ignores noise', () => {
		const { winners, losers } = computeMovers([k('a', 200), k('b', 52), k('c', 10), k('new', 40)], [k('a', 100), k('b', 50), k('c', 60)]);
		expect(winners.map((w) => w.key)).toEqual(['a', 'new']);
		expect(winners[1].deltaPct).toBeNull(); // arrived from nothing
		expect(losers.map((l) => l.key)).toEqual(['c']);
		expect(winners.find((w) => w.key === 'b')).toBeUndefined(); // +2 clicks is noise
	});
	it('new and lost need real impressions and a complete list', () => {
		const r = newAndLost([k('x', 5, 80), k('tiny', 0, 3), k('stay', 9, 90)], [k('stay', 9, 90), k('gone', 4, 60), k('gone-tiny', 0, 2)]);
		expect(r.added.map((x) => x.key)).toEqual(['x']);
		expect(r.lost.map((x) => x.key)).toEqual(['gone']);
	});
	it('bands by rounded position and ignores rows without a position', () => {
		expect(bandOf(3.4)).toBe('1-3');
		expect(bandOf(3.6)).toBe('4-10');
		expect(bandOf(70)).toBe('51+');
		const b = positionBands([m(10, 100, 2), m(5, 100, 8), m(1, 100, 8), m(0, 100, 0), m(0, 0, 4)]);
		expect(b.map((x) => x.queries)).toEqual([1, 2, 0, 0, 0]);
		expect(b[1].clicks).toBe(6);
		expect(BANDS).toHaveLength(5);
	});
});

describe('weekly totals, trajectory, projection', () => {
	const days = Array.from({ length: 70 }, (_, i) => ({ date: new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString().slice(0, 10), clicks: 10, impressions: 100, position: 5 }));
	it('returns only whole 7-day blocks ending on the end date, oldest first', () => {
		const w = weeklyTotals(days, '2026-03-11', 10); // day 69 = 2026-03-11
		expect(w).toHaveLength(10);
		expect(w.every((x) => x.clicks === 70)).toBe(true);
		expect(w[9].weekEnd).toBe('2026-03-11');
		expect(w[0].position).toBe(5);
	});
	it('theilSen shrugs off one outlier week where least squares would not', () => {
		expect(theilSen([10, 12, 14, 16, 200, 20, 22])).toBeCloseTo(2, 0);
	});
	it('trajectory: rising, falling, flat, volatile, too little data', () => {
		expect(trajectoryOf([10, 12, 14, 16, 18, 20, 22, 24]).direction).toBe('rising');
		expect(trajectoryOf([24, 22, 20, 18, 16, 14, 12, 10]).direction).toBe('falling');
		expect(trajectoryOf([20, 20, 21, 20, 19, 20, 20, 21]).direction).toBe('flat');
		expect(trajectoryOf([0, 0, 90, 0, 0, 80, 0, 0]).direction).toBe('volatile');
		expect(trajectoryOf([1, 1, 1]).direction).toBe('too-little-data');
	});
	it('projection continues a trend with damping and a widening band, and refuses short history', () => {
		const rising = Array.from({ length: 12 }, (_, i) => ({ weekEnd: `2026-01-${String(i + 1).padStart(2, '0')}`, clicks: 100 + i * 10, impressions: 0, position: 0 }));
		const p = projectClicks(rising)!;
		expect(p.points).toHaveLength(8);
		expect(p.points[0].clicks).toBeGreaterThan(rising[11].clicks - 20);
		expect(p.points[7].clicks).toBeGreaterThan(p.points[0].clicks);
		// damped: later weeks gain less than a straight line would
		expect(p.points[7].clicks - p.points[0].clicks).toBeLessThan(7 * 10);
		expect(p.points[7].high - p.points[7].low).toBeGreaterThanOrEqual(p.points[0].high - p.points[0].low);
		expect(projectClicks(rising.slice(0, 5))).toBeNull();
		const flatZero = projectClicks(rising.map((r) => ({ ...r, clicks: 0 })))!;
		expect(flatZero.points.every((x) => x.clicks === 0 && x.low === 0)).toBe(true);
	});
});

describe('question queries', () => {
	it('accepts questions and rejects look-alikes', () => {
		for (const q of ['how to prune roses', 'what is seo', 'why is my site slow', 'can dogs eat grapes', 'is it safe to drive', 'best tool?']) expect(isQuestionQuery(q), q).toBe(true);
		for (const q of ['will smith', 'do it', 'how', 'garden tools', 'is', 'whatsapp web', '']) expect(isQuestionQuery(q), q).toBe(false);
	});
});

describe('content groups and topic clusters', () => {
	it('sections by folder; top-level pages share the root group', () => {
		expect(urlSection('https://x.com/blog/post-1')).toBe('/blog/');
		expect(urlSection('https://x.com/blog/')).toBe('/blog/');
		expect(urlSection('https://x.com/about')).toBe('/');
		expect(urlSection('https://x.com/')).toBe('/');
		expect(urlSection('https://x.com/shop/shoes/red', 2)).toBe('/shop/shoes/');
	});
	it('groups with previous-period deltas', () => {
		const now = [{ page: 'https://x.com/blog/a', ...m(30) }, { page: 'https://x.com/blog/b', ...m(20) }, { page: 'https://x.com/shop/z', ...m(5) }];
		const prev = [{ page: 'https://x.com/blog/a', ...m(100) }, { page: 'https://x.com/gone/q', ...m(7) }];
		const g = groupPages(now, prev);
		expect(g[0]).toMatchObject({ key: '/blog/', pages: 2, clicks: 50, prevClicks: 100 });
		expect(g[0].deltaPct).toBeCloseTo(-0.5);
		expect(g.find((x) => x.key === '/gone/')!.clicks).toBe(0);
	});
	it('tokens drop stop words and plurals', () => {
		expect(queryTokens('the best Garden Tools for you')).toEqual(['garden', 'tool']);
	});
	it('clusters by the heaviest shared word, skips brand and ubiquitous words', () => {
		const q = (query: string, clicks: number, impressions = clicks * 10) => ({ query, ...m(clicks, impressions) });
		const rows = [
			q('acme drill review', 5), q('cordless drill 18v', 9), q('drill bits set', 4), q('hammer drill price', 3), q('acme hammer', 2),
			q('claw hammer buy', 6), q('hammer handle repair', 1), q('sledge hammer weight', 2), q('saw blades', 1)
		];
		const { clusters, unclusteredShare } = topicClusters(rows, { minQueries: 3, brandTerms: ['acme'] });
		expect(clusters.map((c) => c.topic).sort()).toEqual(['drill', 'hammer']);
		expect(clusters.find((c) => c.topic === 'drill')!.queries).toBe(4);
		expect(unclusteredShare).toBeGreaterThan(0); // 'saw blades' sits outside any cluster
	});
	it('only complete calendar months go in the heatmap', () => {
		expect(completeMonths('2026-01-15', '2026-04-30')).toEqual(['2026-02', '2026-03', '2026-04']);
		expect(completeMonths('2026-01-01', '2026-04-12')).toEqual(['2026-01', '2026-02', '2026-03']);
		expect(completeMonths('2025-11-01', '2026-02-28')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
	});
	it('heatmap rows report distance from peak and half-on-half trend', () => {
		const months = ['2026-01', '2026-02', '2026-03', '2026-04'];
		const cells = [100, 80, 40, 20].map((c, i) => ({ key: '/blog/', month: months[i], clicks: c })).concat([{ key: '/tiny/', month: '2026-01', clicks: 2 }]);
		const h = buildHeatmap(cells, months);
		expect(h).toHaveLength(1); // /tiny/ is under the minimum
		expect(h[0]).toMatchObject({ key: '/blog/', peak: 0, total: 240 });
		expect(h[0].fromPeakPct).toBeCloseTo(-0.8);
		expect(h[0].trendPct).toBeCloseTo(-0.667, 2);
	});
});

describe('locale and country analysis', () => {
	it('reads locale folders and ignores look-alikes', () => {
		expect(localeOf('https://x.com/en-gb/page')).toMatchObject({ folder: '/en-gb/', lang: 'en', region: 'gb' });
		expect(localeOf('https://x.com/de/seite')).toMatchObject({ lang: 'de', region: null });
		expect(localeOf('https://x.com/ai/tools')).toBeNull();
		expect(localeOf('https://x.com/de')).toBeNull(); // a single page called "de", not a folder
		expect(localeOf('https://x.com/')).toBeNull();
	});
	it('flags a region folder that earns most clicks from elsewhere', () => {
		const rows = [
			{ page: 'https://x.com/en-gb/a', country: 'usa', clicks: 80, impressions: 900 },
			{ page: 'https://x.com/en-gb/a', country: 'gbr', clicks: 20, impressions: 200 },
			{ page: 'https://x.com/en-us/a', country: 'usa', clicks: 90, impressions: 900 },
			{ page: 'https://x.com/en-us/a', country: 'gbr', clicks: 5, impressions: 90 }
		];
		const r = localeReport(rows);
		const gb = r.find((x) => x.folder === '/en-gb/')!;
		expect(gb.homeShare).toBeCloseTo(0.2);
		expect(gb.mismatch).toBe(true);
		expect(r.find((x) => x.folder === '/en-us/')!.mismatch).toBe(false);
	});
	it('country cannibalization only counts pages competing inside one country', () => {
		const row = (country: string, page: string) => ({ query: 'running shoes', page, country, ...m(30, 400, 6) });
		const same = countryCannibalization([row('usa', 'https://x.com/a'), row('usa', 'https://x.com/b')], curve);
		expect(same).toHaveLength(1);
		expect(same[0].country).toBe('usa');
		const split = countryCannibalization([row('usa', 'https://x.com/a'), row('gbr', 'https://x.com/b')], curve);
		expect(split).toHaveLength(0);
	});
});

describe('SEO test statistics', () => {
	it('normal CDF matches known values', () => {
		expect(normalCdf(0)).toBeCloseTo(0.5, 6);
		expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
		expect(normalCdf(-1.96)).toBeCloseTo(0.025, 3);
	});
	it('dispersion is at least 1 and grows with lumpy days', () => {
		expect(dispersion([10, 10, 10, 10, 10, 10])).toBe(1);
		expect(dispersion([0, 40, 0, 40, 0, 40])).toBeGreaterThan(10);
		expect(dispersion([5, 5])).toBe(1); // too few days to estimate
	});
	const arm = (pre: number, post: number, preDays = 28, postDays = 28) => ({ pre: Array(preDays).fill(pre), post: Array(postDays).fill(post) });
	it('detects a clear lift and a clear drop against a flat control', () => {
		const up = liftTest(arm(10, 14), arm(100, 100));
		expect(up.verdict).toBe('positive');
		expect(up.lift).toBeCloseTo(0.4, 1);
		expect(up.ciLow!).toBeGreaterThan(0);
		expect(liftTest(arm(10, 6), arm(100, 100)).verdict).toBe('negative');
	});
	it('a site-wide change is not credited to the test pages', () => {
		const r = liftTest(arm(10, 14), arm(100, 140));
		expect(r.lift!).toBeCloseTo(0, 1);
		expect(r.verdict).toBe('inconclusive');
	});
	it('says too little data instead of guessing', () => {
		expect(liftTest(arm(10, 14, 28, 3), arm(100, 100)).verdict).toBe('too-little-data');
		expect(liftTest(arm(0.5, 1), arm(100, 100)).note).toMatch(/before the change/);
		expect(liftTest(arm(10, 14), arm(1, 1)).note).toMatch(/control/);
		expect(liftTest(arm(10, 14, 28, 10), arm(100, 100)).note).toMatch(/early/);
	});
	it('a page group that went to zero still gives a finite negative result', () => {
		const r = liftTest(arm(10, 0), arm(100, 100));
		expect(Number.isFinite(r.lift!)).toBe(true);
		expect(r.verdict).toBe('negative');
	});
	it('false positive rate on pure noise stays near the nominal 5%', () => {
		let seed = 12345;
		const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
		// Poisson via inversion; daily means with day-to-day lumpiness (overdispersed) shared by both arms' pre and post
		const pois = (lam: number) => { let l = Math.exp(-lam), p = 1, n = 0; do { n++; p *= rnd(); } while (p > l); return n - 1; };
		const day = (mean: number) => pois(mean * (0.5 + rnd()));
		let hits = 0;
		const N = 400;
		for (let i = 0; i < N; i++) {
			const t = { pre: Array.from({ length: 28 }, () => day(12)), post: Array.from({ length: 28 }, () => day(12)) };
			const c = { pre: Array.from({ length: 28 }, () => day(120)), post: Array.from({ length: 28 }, () => day(120)) };
			if (liftTest(t, c).verdict !== 'inconclusive') hits++;
		}
		expect(hits / N).toBeLessThan(0.1);
	});
	it('scopes match by prefix, exact URL and ignore www / trailing slash', () => {
		const s = parseScope('/blog/\nhttps://www.x.com/page-a\nhttps://x.com/shop/*');
		expect(s).toEqual({ prefixes: ['/blog/', 'https://x.com/shop/'], urls: ['https://www.x.com/page-a'] });
		const f = scopeMatcher(s);
		expect(f('https://x.com/blog/post')).toBe(true);
		expect(f('https://x.com/page-a/')).toBe(true);
		expect(f('https://x.com/shop/shoes')).toBe(true);
		expect(f('https://x.com/other')).toBe(false);
	});
	it('picks control pages of similar traffic outside the test group', () => {
		const pages = [...Array.from({ length: 4 }, (_, i) => ({ page: `https://x.com/t/${i}`, clicks: 100 })), ...[1, 3, 90, 110, 95, 5000, 120, 80, 0].map((c, i) => ({ page: `https://x.com/c/${i}`, clicks: c }))];
		const ctrl = pickControl(pages, (p) => p.includes('/t/'), { min: 3 });
		expect(ctrl).toHaveLength(9 - 1 > 12 ? 12 : 8); // 12 wanted (3x4), only 8 non-zero candidates exist
		expect(ctrl.some((p) => p.includes('/t/'))).toBe(false);
		expect(ctrl.indexOf('https://x.com/c/5')).toBeGreaterThan(5); // the 5,000-click page is the worst match
	});
	it('index series sets the pre-period mean to 100', () => {
		const days = Array.from({ length: 10 }, (_, i) => ({ date: `d${i}`, value: i < 5 ? 10 : 20 }));
		const s = indexSeries(days, 5, 1);
		expect(s[0].value).toBe(100);
		expect(s[9].value).toBe(200);
	});
});

describe('indexing', () => {
	it('maps verdicts to states', () => {
		expect(indexState({ verdict: 'PASS' })).toBe('indexed');
		expect(indexState({ verdict: 'NEUTRAL' })).toBe('not_indexed');
		expect(indexState({ verdict: 'FAIL' })).toBe('not_indexed');
		expect(indexState({ verdict: 'VERDICT_UNSPECIFIED' })).toBe('unknown');
		expect(indexState({ error: 'quota' })).toBe('unknown');
		expect(indexState(null)).toBe('unknown');
	});
	it('reports transitions, canonical swaps, robots and fetch changes; nothing on first sight or errors', () => {
		const ok = { verdict: 'PASS', robotsTxtState: 'ALLOWED', pageFetchState: 'SUCCESSFUL', googleCanonical: 'https://x.com/a' };
		expect(diffInspection(null, ok)).toEqual([]);
		expect(diffInspection(ok, { error: 'quota' })).toEqual([]);
		expect(diffInspection(ok, { ...ok, verdict: 'NEUTRAL', coverageState: 'Crawled - currently not indexed' }).map((e) => e.kind)).toEqual(['deindexed']);
		expect(diffInspection({ ...ok, verdict: 'NEUTRAL' }, ok).map((e) => e.kind)).toEqual(['indexed']);
		expect(diffInspection(ok, { ...ok, googleCanonical: 'https://x.com/b' }).map((e) => e.kind)).toEqual(['canonical_changed']);
		expect(diffInspection(ok, { ...ok, googleCanonical: 'https://www.x.com/a/' })).toEqual([]); // same page, different spelling
		expect(diffInspection(ok, { ...ok, robotsTxtState: 'DISALLOWED' }).map((e) => e.kind)).toEqual(['blocked']);
		expect(diffInspection(ok, { ...ok, pageFetchState: 'NOT_FOUND' }).map((e) => e.kind)).toEqual(['fetch_error']);
	});
	it('classifies URLs in the documented order of precedence', () => {
		const base = { clicks: 50, impressions: 1000, position: 5, prevClicks: 50, prevImpressions: 1000 };
		const ctr5 = DEFAULT_CTR[5];
		expect(classifyUrl({ ...base, clicks: Math.round(1000 * ctr5) }, curve)).toBe('healthy');
		expect(classifyUrl({ ...base, impressions: 0, clicks: 0 }, curve)).toBe('dead');
		expect(classifyUrl({ ...base, fetchState: 'NOT_FOUND' }, curve)).toBe('dead');
		expect(classifyUrl({ ...base, index: 'not_indexed' }, curve)).toBe('not-indexed');
		// a soft 404 is a reason Google left the page out of the index, not proof the page is gone
		expect(classifyUrl({ ...base, fetchState: 'SOFT_404', index: 'not_indexed' }, curve)).toBe('not-indexed');
		expect(classifyUrl({ ...base, clicks: Math.round(1000 * ctr5), fetchState: 'SOFT_404', index: 'indexed' }, curve)).toBe('healthy');
		expect(classifyUrl({ ...base, clicks: 20, prevClicks: 60 }, curve)).toBe('fading');
		expect(classifyUrl({ ...base, clicks: 5, prevClicks: 5 }, curve)).toBe('underperforming');
		expect(classifyUrl({ clicks: 0, impressions: 150, position: 40, prevClicks: 0, prevImpressions: 140 }, curve)).toBe('weak');
		expect(classifyUrl({ ...base, impressions: 0, clicks: 0, index: 'not_indexed' }, curve)).toBe('dead'); // dead beats not-indexed
		expect(classifyUrl({ clicks: 0, impressions: 10, position: 40, prevClicks: 0, prevImpressions: 10 }, curve)).toBe('healthy'); // too little to judge
	});
});

describe('on-page parsing and checks', () => {
	const html = `<!doctype html><html lang="en"><head>
	<title>Best Garden Tools &amp; Pruners | Greenleaf</title>
	<meta content="Buy the best garden tools online." name="description">
	<link href="https://x.com/tools/" rel="canonical">
	<meta name="robots" content="index,follow"><meta property="og:title" content="OG">
	<script>var t = "<h1>not a heading</h1>";</script></head><body><h1>Garden <em>Tools</em></h1><h1>Second</h1></body></html>`;
	it('extracts the head tags whatever the attribute order, decoding entities and stripping tags', () => {
		const p = parseOnPage(html);
		expect(p.title).toBe('Best Garden Tools & Pruners | Greenleaf');
		expect(p.description).toBe('Buy the best garden tools online.');
		expect(p.canonical).toBe('https://x.com/tools/');
		expect(p.robots).toBe('index,follow');
		expect(p.lang).toBe('en');
		expect(p.ogTitle).toBe('OG');
		expect(p.h1).toEqual(['Garden Tools', 'Second']); // the <h1> inside the <script> string is not a heading
	});
	it('ignores markup inside comments', () => {
		const p = parseOnPage('<html><head><!-- <title>Old</title><meta name="description" content="old"> --><title>New</title></head></html>');
		expect(p.title).toBe('New');
		expect(p.description).toBeNull();
	});
	it('matches queries exactly, by all words, by some words, or not at all; folds plurals and punctuation', () => {
		expect(matchQuery('Best Garden Tools & Pruners', 'garden tools')).toBe('exact');
		expect(matchQuery('Tools for your garden', 'garden tools')).toBe('all-words');
		expect(matchQuery('Garden furniture', 'garden tools')).toBe('some-words');
		expect(matchQuery('Kitchen knives', 'garden tools')).toBe('none');
		expect(matchQuery('Pruner guide', 'pruners')).toBe('all-words');
		expect(matchQuery(null, 'x')).toBe('none');
		expect(matchQuery('how to prune roses', 'how to prune roses')).toBe('exact');
	});
	it('raises the right issues and scores them', () => {
		const bare = checkPage(parseOnPage('<html><body><p>hi</p></body></html>'), [{ query: 'garden tools', clicks: 10 }]);
		expect(bare.issues.map((i) => i.id)).toEqual(expect.arrayContaining(['no-title', 'no-description', 'no-h1', 'no-lang']));
		const noindex = checkPage(parseOnPage('<html lang=en><head><title>A decent title here</title><meta name="description" content="d"><meta name="robots" content="noindex"></head><body><h1>x</h1></body></html>'), []);
		expect(noindex.issues.find((i) => i.id === 'noindex')!.severity).toBe('bad');
		const miss = checkPage(parseOnPage(html), [{ query: 'kitchen knives', clicks: 9 }, { query: 'garden tools', clicks: 3 }], { pageUrl: 'https://x.com/other/' });
		expect(miss.issues.map((i) => i.id)).toEqual(expect.arrayContaining(['top-query-missing', 'canonical-elsewhere', 'multi-h1']));
		expect(miss.queries[1]).toMatchObject({ title: 'exact', h1: 'exact' });
		expect(onPageScore([])).toBe(100);
		expect(onPageScore(noindex.issues)).toBeLessThan(80);
		expect(onPageScore(Array(10).fill({ id: 'x', severity: 'bad', message: '' }))).toBe(0);
	});
});
