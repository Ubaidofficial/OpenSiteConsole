import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, openDb } from '../src/lib/server/db';
import { ensureDemoAccounts } from '../src/lib/server/accounts';
import { connectCrux } from '../src/lib/server/connect';
import { CruxError, cruxLatest, originCandidates, parseRecord, queryOrigin, syncCrux } from '../src/lib/server/crux';
import { saveIntegration } from '../src/lib/server/links';
import { fmtVital, rate } from '../src/lib/vitals';

beforeEach(() => {
	globalThis.__openSiteConsoleDb = openDb(':memory:');
});

const metric = (p75: number | string, good = 0.7) => ({ histogram: [{ start: 0, end: 1, density: good }, { start: 1, end: 2, density: 0.2 }], percentiles: { p75 } });
const record = { record: { metrics: { largest_contentful_paint: metric(2300, 0.71), interaction_to_next_paint: metric(180, 0.8), cumulative_layout_shift: metric('0.07', 0.9), first_contentful_paint: metric(1500), experimental_time_to_first_byte: metric(600) } } };
const res = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('Chrome UX Report client', () => {
	it('parses p75 values (CLS arrives as a string) and good shares', () => {
		const r = parseRecord('https://a.example', record as never);
		expect(r.values).toEqual({ lcp: 2300, inp: 180, cls: 0.07, fcp: 1500, ttfb: 600 });
		expect(r.goodShare).toEqual({ lcp: 0.71, inp: 0.8, cls: 0.9 });
	});

	it('treats a metric the API does not return as null, not zero', () => {
		const r = parseRecord('https://a.example', { record: { metrics: { largest_contentful_paint: metric(2000) } } } as never);
		expect(r.values.inp).toBeNull();
		expect(r.values.lcp).toBe(2000);
	});

	it('sends origin and form factor with the key, returns null on 404, throws on key problems', async () => {
		let sent: { url: string; body: Record<string, unknown> } | null = null;
		const ok = vi.fn(async (url: string, init?: RequestInit) => ((sent = { url, body: JSON.parse(String(init?.body)) }), res(record)));
		expect((await queryOrigin('KEY', 'https://a.example', 'PHONE', ok as never))?.values.lcp).toBe(2300);
		expect(sent!.url).toBe('https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=KEY');
		expect(sent!.body).toEqual({ origin: 'https://a.example', formFactor: 'PHONE' });
		expect(await queryOrigin('KEY', 'https://small.example', 'DESKTOP', (async () => res({ error: { message: 'not found' } }, 404)) as never)).toBeNull();
		await expect(queryOrigin('BAD', 'https://a.example', 'PHONE', (async () => res({ error: { message: 'API key not valid' } }, 400)) as never)).rejects.toThrow('API key not valid');
	});

	it('guesses origins: URL-prefix names it, a Domain property tries bare then www', () => {
		expect(originCandidates('https://www.example.com/')).toEqual(['https://www.example.com']);
		expect(originCandidates('sc-domain:example.com')).toEqual(['https://example.com', 'https://www.example.com']);
		expect(originCandidates('nonsense')).toEqual([]);
	});
});

describe('ratings', () => {
	it("uses Google's thresholds at their edges", () => {
		expect(rate('lcp', 2500)).toBe('good');
		expect(rate('lcp', 2501)).toBe('needs-improvement');
		expect(rate('lcp', 4000)).toBe('needs-improvement');
		expect(rate('lcp', 4001)).toBe('poor');
		expect(rate('inp', 200)).toBe('good');
		expect(rate('inp', 501)).toBe('poor');
		expect(rate('cls', 0.1)).toBe('good');
		expect(rate('cls', 0.26)).toBe('poor');
		expect(rate('cls', null)).toBeNull();
		expect(fmtVital('lcp', 2300)).toBe('2.30 s');
		expect(fmtVital('inp', 180)).toBe('180 ms');
		expect(fmtVital('cls', 0.074)).toBe('0.07');
	});
});

describe('Core Web Vitals sync', () => {
	async function setup() {
		await ensureDemoAccounts();
		saveIntegration('crux', 'Chrome UX Report', { apiKey: 'KEY' }, {}, false);
	}

	it('falls back from the bare domain to www, stores both devices, and records the origin that had data', async () => {
		await setup();
		const asked: string[] = [];
		const f = vi.fn(async (_u: string, init?: RequestInit) => {
			const b = JSON.parse(String(init?.body));
			asked.push(`${b.formFactor} ${b.origin}`);
			return b.origin.includes('://www.') ? res(record) : res({ error: { message: 'nf' } }, 404);
		});
		const r = await syncCrux(1, { fetchImpl: f as never, today: '2026-11-05' }); // site 1 is a Domain property
		expect(r.stored).toBe(2);
		expect(asked).toEqual(['PHONE https://greenleaf.example', 'PHONE https://www.greenleaf.example', 'DESKTOP https://greenleaf.example', 'DESKTOP https://www.greenleaf.example']);
		const { latest } = cruxLatest(1);
		expect(latest.get('PHONE')!.origin).toBe('https://www.greenleaf.example');
		expect(latest.get('PHONE')!.lcp).toBe(2300);
		expect((db().prepare('SELECT crux_pulled_on p FROM sites WHERE id = 1').get() as { p: string }).p).toBe('2026-11-05');
	});

	it('a site with no field data is not an error', async () => {
		await setup();
		const r = await syncCrux(1, { fetchImpl: (async () => res({ error: { message: 'nf' } }, 404)) as never });
		expect(r.stored).toBe(0);
	});

	it('a rejected key surfaces as an error and stops early', async () => {
		await setup();
		const f = vi.fn(async () => res({ error: { message: 'API key not valid' } }, 400));
		await expect(syncCrux(1, { fetchImpl: f as never })).rejects.toBeInstanceOf(CruxError);
		expect(f).toHaveBeenCalledTimes(1);
	});

	it('connecting validates the key first, and demo mode connects synthetic data', async () => {
		await ensureDemoAccounts();
		await expect(connectCrux('')).rejects.toThrow('Paste your Google API key');
		process.env.DEMO_MODE = '1';
		try {
			const r = await connectCrux('demo');
			expect(r.sites).toBeGreaterThan(0);
			for (let i = 0; i < 100; i++) {
				await new Promise((x) => setTimeout(x, 50));
				if ((db().prepare('SELECT COUNT(*) n FROM crux_daily').get() as { n: number }).n > 0) break;
			}
			expect((db().prepare('SELECT COUNT(*) n FROM crux_daily').get() as { n: number }).n).toBeGreaterThan(0);
		} finally {
			delete process.env.DEMO_MODE;
		}
	});
});
