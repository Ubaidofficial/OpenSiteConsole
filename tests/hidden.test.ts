import { describe, expect, it } from 'vitest';
import { ctrAtPosition, fitCtrCurve, type QPRow, type QRow } from '../src/lib/analytics';
import { bingGaps, clarityFriction, conversionLeaks, deviceGaps, engagementLeaks, hiddenGems, lostQueries, normQuery, pagesNotInBing, pagesOnTheEdge, questionGaps, risingQueries, siteRates } from '../src/lib/hidden';
import { isQuestionQuery } from '../src/lib/trends';

const curve = fitCtrCurve([]); // the built-in curve, so every expected number below is exact
const q = (query: string, clicks: number, impressions: number, position: number): QRow => ({ query, clicks, impressions, position });
const gain = (impressions: number, from: number, to: number) => Math.max(0, impressions * (ctrAtPosition(curve, to) - ctrAtPosition(curve, from)));
const BRAND = ['acme'];

describe('normQuery', () => {
	it('ignores case and spacing so one search matches across sources', () => {
		expect(normQuery('  Garden   TOOLS ')).toBe('garden tools');
	});
});

describe('lostQueries', () => {
	const prev = [q('big loss', 40, 800, 3), q('kept', 20, 400, 4), q('tiny', 5, 100, 5), q('acme shop', 50, 500, 1), q('gone quietly', 12, 200, 6), q('Edge Case', 20, 300, 5)];
	const now = [q('big loss', 2, 700, 14), q('kept', 12, 380, 4), q('acme shop', 1, 40, 9), q('edge  case', 5, 100, 6)];
	const rows = lostQueries(now, prev, BRAND);

	it('finds searches that earned clicks before and have nearly stopped, biggest loss first', () => {
		expect(rows.map((r) => r.query)).toEqual(['big loss', 'Edge Case', 'gone quietly']);
		expect(rows[0]).toMatchObject({ prevClicks: 40, clicks: 2, lostClicks: 38, positionPrev: 3, positionNow: 14 });
	});
	it('reports a search that disappeared from the data as having no position now', () => {
		expect(rows.find((r) => r.query === 'gone quietly')).toMatchObject({ clicks: 0, impressions: 0, positionNow: null, lostClicks: 12 });
	});
	it('keeps searches that still hold more than a quarter of their clicks, and leaves brand and tiny ones out', () => {
		expect(rows.map((r) => r.query)).not.toContain('kept'); // 12 of 20 clicks left
		expect(rows.map((r) => r.query)).not.toContain('tiny'); // below the 8-click floor
		expect(rows.map((r) => r.query)).not.toContain('acme shop'); // brand
	});
	it('the quarter-of-clicks line is inclusive, and matching ignores case and spacing', () => {
		expect(rows.map((r) => r.query)).toContain('Edge Case'); // exactly 5 of 20 left, found despite "edge  case"
		expect(lostQueries([q('x', 6, 10, 5)], [q('x', 20, 40, 5)], [])).toEqual([]); // 6 of 20 is above a quarter
		expect(lostQueries([q('kept  case', 12, 10, 5)], [q('Kept Case', 20, 40, 5)], [])).toEqual([]); // the same search under another case and spacing is not lost
	});
	it('honours the click floor and the limit', () => {
		expect(lostQueries([], [q('a', 7, 10, 3)], [])).toEqual([]);
		expect(lostQueries([], [q('a', 8, 10, 3)], [])).toHaveLength(1);
		expect(lostQueries([], [q('a', 9, 1, 1), q('b', 10, 1, 1)], [], { limit: 1 })).toHaveLength(1);
	});
});

describe('risingQueries', () => {
	const prev = [q('doubled', 1, 50, 9), q('almost', 1, 51, 9), q('small step', 0, 20, 9), q('won already', 5, 50, 3)];
	const now = [q('doubled', 2, 100, 10), q('almost', 2, 100, 10), q('brand new', 0, 80, 12), q('small step', 1, 45, 9), q('won already', 20, 200, 3), q('acme thing', 0, 300, 20), q('far off', 0, 90, 41), q('just 5', 0, 90, 5.9)];
	const rows = risingQueries(now, prev, curve, BRAND);

	it('finds searches whose impressions at least doubled and that are not yet won', () => {
		expect(rows.map((r) => r.query).sort()).toEqual(['brand new', 'doubled']);
	});
	it('prices the prize as reaching position 5 on the current impressions, and flags searches that are new', () => {
		const d = rows.find((r) => r.query === 'doubled')!;
		expect(d).toMatchObject({ impressions: 100, prevImpressions: 50, isNew: false });
		expect(d.gain).toBeCloseTo(gain(100, 10, 5));
		expect(rows.find((r) => r.query === 'brand new')).toMatchObject({ isNew: true, prevImpressions: 0 });
		expect(gain(80, 12, 5)).toBeGreaterThan(gain(100, 10, 5));
		expect(rows.map((r) => r.query)).toEqual(['brand new', 'doubled']); // biggest prize first
	});
	it('the doubling line is inclusive, and the growth must be big enough in absolute terms', () => {
		expect(rows.map((r) => r.query)).toContain('doubled'); // exactly 2x
		expect(rows.map((r) => r.query)).not.toContain('almost'); // 100 against 51 is just under 2x
		expect(rows.map((r) => r.query)).not.toContain('small step'); // 2.25x but only 25 more impressions
	});
	it('leaves out brand, searches already in the top five, and ones too far down to chase', () => {
		for (const bad of ['acme thing', 'won already', 'far off', 'just 5']) expect(rows.map((r) => r.query)).not.toContain(bad);
		expect(risingQueries([q('edge', 0, 80, 6)], [], curve, [])).toHaveLength(1); // position 6 is the first chased
		expect(risingQueries([q('edge', 0, 80, 40)], [], curve, [])).toHaveLength(1); // 40 is the last
		expect(risingQueries([q('floor', 0, 40, 10)], [], curve, [])).toHaveLength(1); // exactly the impressions floor counts
		expect(risingQueries([q('floor', 0, 39, 10)], [], curve, [])).toHaveLength(0);
	});
});

describe('bingGaps', () => {
	const google = [q('both top', 9, 200, 3), q('google low', 1, 200, 15), q('google edge', 1, 200, 10.9), q('Case Match', 0, 120, 30)];
	const bing = [q('both top', 5, 90, 2), q('google low', 3, 60, 3), q('not in google', 4, 70, 1), q('google edge', 3, 60, 2), q('case  match', 2, 50, 4), q('bing weak', 1, 99, 5.5), q('too few', 1, 19, 2), q('acme bing', 1, 80, 1), q('zero pos', 0, 80, 0)];
	const rows = bingGaps(bing, google, curve, BRAND);

	it('finds searches where Bing ranks in the top five and Google ranks far down or nowhere', () => {
		expect(rows.map((r) => r.query).sort()).toEqual(['case  match', 'google low', 'not in google']);
	});
	it('prices the gap on Google impressions, and says nothing when Google never shows the site', () => {
		const g = rows.find((r) => r.query === 'google low')!;
		expect(g).toMatchObject({ bingPosition: 3, googlePosition: 15, googleImpressions: 200 });
		expect(g.gain).toBeCloseTo(gain(200, 15, 5));
		expect(rows.find((r) => r.query === 'not in google')).toMatchObject({ googlePosition: null, googleImpressions: 0, gain: null });
		expect(rows.find((r) => r.query === 'case  match')!.gain).toBeCloseTo(gain(120, 30, 5)); // matched to "Case Match" in Google despite case and spacing
	});
	it('ranks priced gaps first, biggest first, and the unpriced ones last', () => {
		expect(gain(200, 15, 5)).toBeGreaterThan(gain(120, 30, 5));
		expect(rows.map((r) => r.query)).toEqual(['google low', 'case  match', 'not in google']);
	});
	it('leaves out searches Google already ranks within the top ten, weak Bing positions, thin data and brand', () => {
		for (const bad of ['both top', 'google edge', 'bing weak', 'too few', 'acme bing', 'zero pos']) expect(rows.map((r) => r.query)).not.toContain(bad);
	});
	it('the position lines are inclusive: Bing 5.0 counts, Google 11.0 counts', () => {
		expect(bingGaps([q('a', 1, 20, 5)], [q('a', 1, 50, 11)], curve, [])).toHaveLength(1);
		expect(bingGaps([q('a', 1, 20, 5)], [q('a', 1, 50, 10.99)], curve, [])).toHaveLength(0);
	});
});

describe('pagesNotInBing', () => {
	const google = [
		{ page: 'https://x.com/a/', clicks: 30, impressions: 1, position: 3 }, { page: 'http://www.x.com/a', clicks: 10, impressions: 1, position: 3 },
		{ page: 'https://x.com/b', clicks: 20, impressions: 1, position: 3 }, { page: 'https://x.com/c', clicks: 9, impressions: 1, position: 3 }, { page: 'https://x.com/d?utm=1', clicks: 15, impressions: 1, position: 3 }
	];
	it('lists pages with Google clicks and no Bing impressions, comparing by path so variants count once', () => {
		const rows = pagesNotInBing(google, new Set(['/b']));
		expect(rows).toEqual([{ page: 'https://x.com/a/', clicks: 40 }, { page: 'https://x.com/d?utm=1', clicks: 15 }]);
	});
	it('skips pages below the click floor, which is inclusive', () => {
		expect(pagesNotInBing(google, new Set(), { minClicks: 9 }).map((r) => r.clicks)).toEqual([40, 20, 15, 9]);
		expect(pagesNotInBing(google, new Set(), { minClicks: 10 }).map((r) => r.clicks)).toEqual([40, 20, 15]);
	});
});

describe('GA4: engagement and conversion leaks', () => {
	const pages = [
		{ page: '/', sessions: 700, engagedSessions: 490, keyEvents: 35 },
		{ page: '/leaky', sessions: 200, engagedSessions: 40, keyEvents: 0 },
		{ page: '/ok', sessions: 100, engagedSessions: 60, keyEvents: 4 }
	];
	it('measures the site rates over all landing pages', () => {
		const r = siteRates(pages);
		expect(r.sessions).toBe(1000);
		expect(r.engagementRate).toBeCloseTo(0.59);
		expect(r.keyEventRate).toBeCloseTo(0.039);
		expect(siteRates([])).toEqual({ sessions: 0, engagementRate: 0, keyEventRate: 0 });
	});
	it('flags a busy page where far fewer visitors engage than on the site, and counts the visits it loses', () => {
		const rows = engagementLeaks(pages);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ page: '/leaky', sessions: 200, engagementRate: 0.2 });
		expect(rows[0].lostEngagedSessions).toBeCloseTo(200 * (0.59 - 0.2));
	});
	it('needs enough traffic on the page and on the site to say anything', () => {
		expect(engagementLeaks(pages, { minSessions: 201 })).toEqual([]);
		expect(engagementLeaks(pages, { minSiteSessions: 1001 })).toEqual([]);
		expect(engagementLeaks([{ page: '/a', sessions: 300, engagedSessions: 0, keyEvents: 0 }])).toEqual([]); // no site engagement to compare with
	});
	it('the page line is inclusive, the ratio line is strict, and the site must have at least the minimum sessions', () => {
		const site = [{ page: '/', sessions: 800, engagedSessions: 440, keyEvents: 0 }];
		const exactly = [...site, { page: '/b', sessions: 200, engagedSessions: 60, keyEvents: 0 }]; // site 50%, this page exactly 60% of that
		expect(engagementLeaks(exactly)).toEqual([]);
		const worse = [...site, { page: '/b', sessions: 200, engagedSessions: 40, keyEvents: 0 }];
		expect(engagementLeaks(worse, { minSessions: 200 }).map((r) => r.page)).toEqual(['/b']); // 200 sessions is enough
		expect(engagementLeaks(worse, { minSessions: 200, minSiteSessions: 1000 }).map((r) => r.page)).toEqual(['/b']); // exactly 1,000 site sessions is enough
	});
	it('a conversion leak needs expected key events at the line (inclusive), no key events at all, and the page line inclusive', () => {
		const site = [{ page: '/', sessions: 700, engagedSessions: 0, keyEvents: 19 }, { page: '/b', sessions: 150, engagedSessions: 0, keyEvents: 0 }, { page: '/c', sessions: 150, engagedSessions: 0, keyEvents: 1 }];
		expect(conversionLeaks(site, { minSessions: 150 }).map((r) => r.page)).toEqual(['/b']); // 3 expected (the line) and 0 events; /c has one
	});
	it('flags a busy page with no key events on a site where visitors do convert, and not otherwise', () => {
		const rows = conversionLeaks(pages);
		expect(rows.map((r) => r.page)).toEqual(['/leaky']);
		expect(rows[0].expectedKeyEvents).toBeCloseTo(200 * 0.039);
		expect(conversionLeaks(pages.map((p) => ({ ...p, keyEvents: 0 })))).toEqual([]); // nothing converts anywhere: not a page problem
		expect(conversionLeaks(pages, { minSessions: 201 })).toEqual([]);
		expect(conversionLeaks(pages, { minExpected: 8 })).toEqual([]); // 200 x 3.9% = 7.8 expected: not enough to be sure
		expect(conversionLeaks(pages, { minSiteSessions: 1001 })).toEqual([]);
	});
});

describe('hiddenGems', () => {
	const ga = [
		{ page: '/', sessions: 800, engagedSessions: 480, keyEvents: 24 },
		{ page: '/gem', sessions: 100, engagedSessions: 80, keyEvents: 8 },
		{ page: '/no-conv', sessions: 100, engagedSessions: 80, keyEvents: 0 },
		{ page: '/shallow', sessions: 100, engagedSessions: 50, keyEvents: 9 },
		{ page: '/top', sessions: 100, engagedSessions: 80, keyEvents: 8 },
		{ page: '/deep', sessions: 100, engagedSessions: 80, keyEvents: 8 },
		{ page: '/quiet', sessions: 100, engagedSessions: 80, keyEvents: 8 },
		{ page: '/few', sessions: 29, engagedSessions: 25, keyEvents: 3 }
	];
	const g = (url: string, impressions: number, position: number) => ({ url: 'https://x.com' + url, clicks: 10, impressions, position });
	const google = [g('/gem', 500, 8), g('/no-conv', 500, 8), g('/shallow', 500, 8), g('/top', 500, 3.9), g('/deep', 500, 21), g('/quiet', 99, 8), g('/few', 500, 8)];
	const rows = hiddenGems(ga, google, curve);

	it('finds the page that engages and converts better than the site and sits at positions 4 to 20', () => {
		expect(rows.map((r) => r.page)).toEqual(['/gem']);
		expect(rows[0]).toMatchObject({ sessions: 100, position: 8, impressions: 500 });
		expect(rows[0].engagementRate).toBeCloseTo(0.8);
		expect(rows[0].keyEventRate).toBeCloseTo(0.08);
		expect(rows[0].gain).toBeCloseTo(gain(500, 8, 3));
	});
	it('needs both better engagement and clearly better conversion where the site measures conversions', () => {
		expect(rows.map((r) => r.page)).not.toContain('/no-conv'); // engages but never converts
		expect(rows.map((r) => r.page)).not.toContain('/shallow'); // converts but does not engage
	});
	it('leaves out pages already near the top, far down, barely shown, or with too few visits', () => {
		for (const bad of ['/top', '/deep', '/quiet', '/few']) expect(rows.map((r) => r.page)).not.toContain(bad);
	});
	it('with no conversions measured anywhere, engagement alone qualifies', () => {
		const flat = ga.map((p) => ({ ...p, keyEvents: 0 }));
		expect(hiddenGems(flat, google, curve).map((r) => r.page).sort()).toEqual(['/gem', '/no-conv'].sort());
	});
	it('needs clearly better engagement (10% above the site) and clearly better conversion (50% above), and the visit and impression lines are inclusive', () => {
		const fx = [
			{ page: '/', sessions: 700, engagedSessions: 308, keyEvents: 19 },
			{ page: '/c1', sessions: 100, engagedSessions: 52, keyEvents: 8 }, // engages 52% against the site's 50%: not clearly better
			{ page: '/c2', sessions: 100, engagedSessions: 70, keyEvents: 5 }, // converts 5% against 4%: not clearly better
			{ page: '/c3', sessions: 100, engagedSessions: 70, keyEvents: 8 }
		]; // the site: 1,000 sessions, 50% engaged, 4% key events
		const goog = ['/c1', '/c2', '/c3'].map((u) => g(u, 500, 8));
		expect(hiddenGems(fx, goog, curve, { minSessions: 100, minImpressions: 500 }).map((r) => r.page)).toEqual(['/c3']);
	});
	it('the position lines are inclusive (4 and 20) and a thin site gives nothing', () => {
		expect(hiddenGems(ga, [g('/gem', 500, 4)], curve)).toHaveLength(1);
		expect(hiddenGems(ga, [g('/gem', 500, 20)], curve)).toHaveLength(1);
		expect(hiddenGems(ga, google, curve, { minSiteSessions: 2000 })).toEqual([]);
	});
});

describe('clarityFriction', () => {
	const clicks = new Map([['/a', 100], ['/b', 100], ['/c', 100], ['/d', 100]]);
	const pages = [
		{ url: 'https://x.com/a', sessions: 100, rageClicks: 8, deadClicks: 3 },
		{ url: '/b', sessions: 100, rageClicks: 2, deadClicks: 4 },
		{ url: '/c', sessions: 29, rageClicks: 20, deadClicks: 20 },
		{ url: '/nowhere', sessions: 100, rageClicks: 50, deadClicks: 50 },
		{ url: '/d', sessions: 200, rageClicks: null, deadClicks: 10 }
	];
	it('flags search-landing pages where at least 5% of sessions had rage or dead clicks, counting each session once', () => {
		const rows = clarityFriction(pages, clicks);
		expect(rows.map((r) => r.page)).toEqual(['/a', '/d']);
		expect(rows[0]).toMatchObject({ sessions: 100, frictionSessions: 8, rate: 0.08, googleClicks: 100 });
		expect(rows[1].frictionSessions).toBe(10); // 10 of 200 = 5%, inclusive
	});
	it('the session line is inclusive', () => {
		expect(clarityFriction([{ url: '/a', sessions: 30, rageClicks: 3, deadClicks: null }], clicks).map((r) => r.page)).toEqual(['/a']);
	});
	it('leaves out pages with too few sessions, a lower rate, or that Google does not send anyone to', () => {
		const rows = clarityFriction(pages, clicks).map((r) => r.page);
		for (const bad of ['/b', '/c', '/nowhere']) expect(rows).not.toContain(bad);
	});
});

describe('deviceGaps', () => {
	const desktop = [q('gap', 5, 100, 4), q('close', 5, 100, 4), q('exact', 5, 100, 4), q('thin', 5, 19, 4), q('acme gap', 5, 100, 1), q('no mobile impressions', 5, 100, 4)];
	const mobile = [q('gap', 1, 300, 12), q('close', 1, 300, 6.9), q('exact', 1, 300, 7), q('thin', 1, 300, 12), q('acme gap', 1, 300, 12), q('only mobile', 1, 300, 12), q('no mobile impressions', 0, 39, 12)];
	const rows = deviceGaps(mobile, desktop, curve, BRAND);
	it('finds searches that rank at least three places worse on phones than on desktop', () => {
		expect(rows.map((r) => r.query).sort()).toEqual(['exact', 'gap']);
		expect(rows.find((r) => r.query === 'gap')!.gain).toBeCloseTo(gain(300, 12, 4));
		expect(rows[0].query).toBe('gap'); // the bigger gap is worth more
	});
	it('the phone and desktop impression floors are inclusive', () => {
		expect(deviceGaps([q('edge', 0, 40, 12)], [q('edge', 0, 20, 4)], curve, [])).toHaveLength(1);
		expect(deviceGaps([q('edge', 0, 39, 12)], [q('edge', 0, 20, 4)], curve, [])).toHaveLength(0);
		expect(deviceGaps([q('edge', 0, 40, 12)], [q('edge', 0, 19, 4)], curve, [])).toHaveLength(0);
	});
	it('needs data on both devices and enough of it, and ignores brand', () => {
		for (const bad of ['close', 'thin', 'acme gap', 'only mobile', 'no mobile impressions']) expect(rows.map((r) => r.query)).not.toContain(bad);
	});
});

describe('pagesOnTheEdge', () => {
	const row = (page: string, query: string, impressions: number, position: number): QPRow => ({ page, query, clicks: 0, impressions, position });
	const rows = [
		row('/p', 'a', 40, 5), row('/p', 'b', 30, 9), row('/p', 'c', 20, 12), row('/p', 'd', 10, 20), row('/p', 'g', 10, 4), row('/p', 'e', 500, 3.9), row('/p', 'acme f', 80, 6),
		row('/three', 'a', 60, 5), row('/three', 'b', 60, 9), row('/three', 'c', 60, 12),
		row('/thin', 'a', 10, 5), row('/thin', 'b', 10, 9), row('/thin', 'c', 10, 12), row('/thin', 'd', 9, 6), row('/thin', 'e', 10, 7)
	];
	const out = pagesOnTheEdge(rows, curve, BRAND);
	it('finds a page that sits at positions 4 to 20 for several searches, with the sum of what lifting them is worth', () => {
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ page: '/p', queries: 5, impressions: 110 });
		expect(out[0].gain).toBeCloseTo(gain(40, 5, 5) + gain(30, 9, 5) + gain(20, 12, 5) + gain(10, 20, 5) + gain(10, 4, 5)); // each priced at position 5; a search already at 4 adds nothing
		expect(gain(30, 9, 5)).toBeGreaterThan(0);
		expect(out[0].gain).toBeCloseTo(gain(30, 9, 5) + gain(20, 12, 5) + gain(10, 20, 5) + gain(40, 5, 5));
		expect(pagesOnTheEdge(rows, curve, BRAND, { targetPos: 3 })[0].gain).toBeGreaterThan(out[0].gain); // the target is what prices it
		expect(out[0].top.map((t) => t.query)).toEqual(['a', 'b', 'c', 'd', 'g']);
	});
	it('counts only searches inside positions 4 to 20 (both inclusive) and not brand', () => {
		expect(out[0].queries).toBe(5); // positions 4 and 20 count; 3.9 and the brand search do not
	});
	it('four searches and 100 impressions in total are exactly enough', () => {
		const four = [row('/four', 'a', 30, 5), row('/four', 'b', 30, 6), row('/four', 'c', 20, 7), row('/four', 'd', 20, 8)];
		expect(pagesOnTheEdge(four, curve, []).map((p) => p.page)).toEqual(['/four']);
		expect(pagesOnTheEdge(four.slice(0, 3), curve, [])).toEqual([]); // three searches
		expect(pagesOnTheEdge([...four.slice(0, 3), row('/four', 'd', 19, 8)], curve, [])).toEqual([]); // 99 impressions
	});
	it('needs several searches and enough impressions in total', () => {
		expect(out.map((p) => p.page)).not.toContain('/three'); // only three searches
		expect(out.map((p) => p.page)).not.toContain('/thin'); // 49 impressions and one search under the per-search floor
	});
});

describe('questionGaps', () => {
	const rows = [q('how to prune roses', 1, 100, 9), q('what is mulch', 0, 15, 8), q('how to x', 0, 14, 12), q('best roses', 3, 400, 12), q('how to win at acme', 0, 90, 14), q('how close', 9, 300, 7.9), q('how far', 0, 90, 51), q('why is soil acidic?', 0, 60, 30)];
	const out = questionGaps(rows, curve, BRAND, isQuestionQuery);
	it('lists question-shaped searches where the site ranks below position 7, biggest prize first', () => {
		expect(out.map((r) => r.query)).toEqual(['how to prune roses', 'why is soil acidic?', 'what is mulch']);
		expect(out[0].gain).toBeCloseTo(gain(100, 9, 5));
	});
	it('leaves out statements, brand, thin data and positions at either extreme', () => {
		for (const bad of ['best roses', 'how to win at acme', 'how to x', 'how close', 'how far']) expect(out.map((r) => r.query)).not.toContain(bad);
	});
	it('the upper position line (50) is inclusive too', () => {
		expect(questionGaps([q('what is fifty', 0, 20, 50)], curve, [], isQuestionQuery)).toHaveLength(1);
		expect(questionGaps([q('what is fifty', 0, 20, 50.5)], curve, [], isQuestionQuery)).toHaveLength(0);
	});
	it('the lower position line (8) and the floor (15 impressions) are inclusive', () => {
		expect(out.map((r) => r.query)).toContain('what is mulch');
	});
});
