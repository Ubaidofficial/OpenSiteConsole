import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { COMPETITORS, bySlug, groupsOf, CHECKED_ON, DEFAULT_HOSTED_PRICE } from '../src/lib/compare';
import { pageTitle } from '../src/lib/titles';
import { handle } from '../src/hooks.server';
import { config } from '../src/lib/server/config';

const all = COMPETITORS.flatMap((c) => c.rows.map((r) => ({ c, r })));

describe('the comparison pages are fair', () => {
	it('cover the tools people weigh SEOConsole against, each with a distinct address', () => {
		expect(COMPETITORS.map((c) => c.slug)).toEqual(['seotesting', 'indexchex', 'promptwatch', 'google-search-console']);
		expect(new Set(COMPETITORS.map((c) => c.slug)).size).toBe(COMPETITORS.length);
		for (const c of COMPETITORS) expect(bySlug(c.slug)).toBe(c);
		expect(bySlug('nope')).toBeUndefined();
	});
	it('each says where it was read and when, and lists its sources as real https addresses', () => {
		for (const c of COMPETITORS) {
			expect(c.checkedOn, c.slug).toBe(CHECKED_ON);
			expect(CHECKED_ON).toMatch(/^\d{4}-\d{2}-\d{2}$/);
			expect(c.price.length, c.slug).toBeGreaterThan(3);
			expect(c.sources.length, c.slug).toBeGreaterThan(0);
			for (const s of c.sources) expect(s.url, `${c.slug}: ${s.label}`).toMatch(/^https:\/\/[^\s]+$/);
			expect(c.url).toMatch(/^https:\/\//);
			expect(c.rows.length, c.slug).toBeGreaterThanOrEqual(10);
			for (const g of groupsOf(c.rows)) expect(c.rows.filter((r) => r.group === g).length).toBeGreaterThan(0);
		}
	});
	it('none is one-sided: every page lists where the competitor is ahead, and every competitor is ahead somewhere in the table', () => {
		for (const c of COMPETITORS) {
			expect(c.weWin.length, c.slug).toBeGreaterThan(0);
			expect(c.theyWin.length, c.slug).toBeGreaterThan(0);
			const theirLead = c.rows.filter((r) => r.theirs.v === 'yes' && r.ours.v !== 'yes');
			expect(theirLead.length, `${c.slug}: a row where they are ahead`).toBeGreaterThan(0);
		}
	});
	it('what SEOConsole does not do is marked No, however good it would look to claim it', () => {
		const mustBeNo: [RegExp, string][] = [
			[/LLM tests/, 'seotesting'], [/Internal-linking tool/, 'seotesting'],
			[/Check any URL, such as backlinks/, 'indexchex'], [/Get third-party or backlink URLs crawled/, 'indexchex'], [/Instant/i, 'indexchex'],
			[/Track prompts across AI models/, 'promptwatch'], [/Citation and source analysis/, 'promptwatch'], [/Competitor share of voice/, 'promptwatch'], [/AI crawler logs/, 'promptwatch'],
			[/Removals, Manual actions/, 'google-search-console']
		];
		for (const [re, slug] of mustBeNo) {
			const row = bySlug(slug)!.rows.find((r) => re.test(r.feature));
			expect(row, `${slug}: ${re}`).toBeDefined();
			expect(row!.ours.v, `${slug}: ${row!.feature}`).toBe('no');
		}
		// built since: several users with roles (the Team page), which the README documents
		const users = bySlug('seotesting')!.rows.find((r) => r.feature === 'More than one user')!;
		expect(users.ours.v).toBe('yes');
		expect(users.ours.note).toMatch(/Unlimited users, free/);
		expect(readFileSync('README.md', 'utf8')).toMatch(/## Team and roles/);
		// and the things it only half does say "partly", with the reason
		for (const [slug, re] of [['seotesting', /Monthly plain-English report/], ['seotesting', /Daily watch/], ['indexchex', /Google’s Indexing API/], ['google-search-console', /^Request Indexing$/]] as const) {
			const row = bySlug(slug)!.rows.find((r) => re.test(r.feature))!;
			expect(row.ours.v, `${slug}: ${row.feature}`).toBe('partial');
			expect(row.ours.note!.length).toBeGreaterThan(20);
		}
	});
	it('every page owns up that SEOConsole is young and has not been run against live Google data', () => {
		for (const c of COMPETITORS) {
			const row = c.rows.find((r) => r.feature === 'How established it is')!;
			expect(row.ours.v).toBe('partial');
			expect(row.ours.note).toMatch(/not yet run against live Google data/);
		}
	});
	it('"not stated" is never passed off as "no", and a verdict that is not a plain yes carries its reason', () => {
		for (const { c, r } of all) {
			if (r.theirs.v === 'unknown') expect(r.theirs.note, `${c.slug}: ${r.feature}`).toMatch(/not stated|Its pages list|method is not explained|Not stated/i);
			if (r.ours.v === 'no' || r.ours.v === 'partial') expect(r.ours.note, `${c.slug}: ${r.feature}`).toBeTruthy();
		}
	});
	it('nothing that goes stale is hard-coded: no tool counts, no test counts', () => {
		const text = JSON.stringify(COMPETITORS);
		expect(text).not.toMatch(/\b\d+ tools\b/);
		expect(text).not.toMatch(/\b\d{3} tests\b/);
	});
	it('the screenshots exist, are small enough to load fast, and are described', () => {
		const seen = new Set<string>();
		for (const c of COMPETITORS) {
			expect(c.shots.length, c.slug).toBeGreaterThan(0);
			for (const s of c.shots) {
				expect(s.src).toMatch(/^\/img\/compare\/[a-z-]+\.jpg$/);
				const file = `static${s.src}`;
				expect(existsSync(file), file).toBe(true);
				expect(statSync(file).size, file).toBeLessThan(300_000);
				expect(s.alt.length).toBeGreaterThan(20);
				expect(s.caption.length).toBeGreaterThan(20);
				seen.add(s.src);
			}
		}
		expect(seen.size).toBeGreaterThanOrEqual(6);
	});
	it('the hosted price is words the owner can change, and says what it covers', () => {
		expect(DEFAULT_HOSTED_PRICE).toMatch(/\$9 a month/);
		expect(readFileSync('src/routes/compare/+page.server.ts', 'utf8')).toMatch(/COMPARE_HOSTED_PRICE/);
		expect(readFileSync('src/routes/compare/[slug]/+page.server.ts', 'utf8')).toMatch(/COMPARE_HOSTED_PRICE/);
	});
});

describe('the comparison routes', () => {
	it('an unknown comparison is a 404, a known one carries its data', async () => {
		const mod = await import('../src/routes/compare/[slug]/+page.server');
		const ok = (await mod.load({ params: { slug: 'seotesting' } } as never)) as { c: { name: string } };
		expect(ok.c.name).toBe('SEOTesting.com');
		await expect(Promise.resolve().then(() => mod.load({ params: { slug: 'nope' } } as never))).rejects.toMatchObject({ status: 404 });
		const idx = await import('../src/routes/compare/+page.server');
		const out = (await idx.load({} as never)) as { tools: { slug: string }[]; hosted: string; checkedOn: string };
		expect(out.tools.map((t) => t.slug)).toEqual(COMPETITORS.map((c) => c.slug));
		expect(out.checkedOn).toBe(CHECKED_ON);
	});
	it('are readable without signing in, and show a signed-out visitor no menu; the footer and tab titles know them', async () => {
		process.env.ADMIN_PASSWORD = 'pw-for-compare-tests';
		expect(config.hasPassword).toBe(true);
		const ev = (path: string) => {
			const url = new URL(`http://localhost:5173${path}`);
			return { url, request: new Request(url, { headers: { host: 'localhost:5173' } }), locals: {} as Record<string, unknown>, cookies: { get: () => undefined }, getClientAddress: () => '127.0.0.1' };
		};
		const run = (path: string) => handle({ event: ev(path) as never, resolve: (async () => new Response('page')) as never });
		for (const p of ['/compare', '/compare/seotesting', '/compare/indexchex', '/compare/promptwatch', '/compare/google-search-console']) expect((await run(p)).status, p).toBe(200);
		expect((await run('/sites/1/tests')).status).toBe(303); // the rest of the app is still behind the login
		expect((await run('/comparex')).status).toBe(303);
		expect(readFileSync('src/routes/+layout.svelte', 'utf8')).toMatch(/\{#if data\.authed\}<nav/);
		expect(readFileSync('src/routes/+layout.svelte', 'utf8')).toMatch(/href="\/compare">Compare</);
		expect(pageTitle('/compare')).toBe('Compare · SEOConsole');
		expect(pageTitle('/compare/seotesting')).toBe('Compare · SEOConsole');
		delete process.env.ADMIN_PASSWORD;
	});
	it('the table shows the word as well as the symbol, so it does not rely on colour', () => {
		const t = readFileSync('src/lib/components/VerdictCell.svelte', 'utf8');
		expect(t).toMatch(/VERDICT_LABEL\[cell\.v\]/);
		expect(t).toMatch(/aria-hidden="true"/);
		expect(readFileSync('src/routes/compare/[slug]/+page.svelte', 'utf8')).toMatch(/Not stated.*not the same as/s);
	});
});
