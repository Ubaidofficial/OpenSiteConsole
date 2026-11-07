import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SITE_TABS } from '../src/lib/explain';
import { pageTitle } from '../src/lib/titles';

describe('browser tab titles', () => {
	it('name the page, not the site (privacy mode cannot blur the tab strip or history)', () => {
		expect(pageTitle('/')).toBe('Dashboard · SEOConsole');
		expect(pageTitle('/actions')).toBe('What to do first · SEOConsole');
		expect(pageTitle('/portfolio')).toBe('Portfolio · SEOConsole');
		expect(pageTitle('/login')).toBe('Sign in · SEOConsole');
		expect(pageTitle('/sites/12')).toBe('Overview · SEOConsole');
		expect(pageTitle('/sites/12/queries')).toBe('Queries · SEOConsole');
		expect(pageTitle('/sites/12/analytics')).toBe('GA4 · SEOConsole');
	});
	it('tolerates trailing slashes and falls back to the app name for unknown paths', () => {
		expect(pageTitle('/digest/')).toBe('Weekly digest · SEOConsole');
		expect(pageTitle('/sites/3/')).toBe('Overview · SEOConsole');
		expect(pageTitle('/nope')).toBe('SEOConsole');
		expect(pageTitle('/sites/3/nope')).toBe('SEOConsole');
		expect(pageTitle('/sites/abc')).toBe('SEOConsole');
	});
	it('every tab gets its own title', () => {
		const titles = SITE_TABS.map(([t]) => pageTitle(`/sites/1${t}`));
		expect(new Set(titles).size).toBe(SITE_TABS.length);
		expect(titles.every((t) => t.endsWith(' · SEOConsole'))).toBe(true);
	});
});

describe('site tabs', () => {
	it('the tab list matches the site pages that exist, so a new page cannot ship without a tab, a title and an explanation', () => {
		const dir = 'src/routes/sites/[id]';
		const pages = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(join(dir, d.name, '+page.svelte'))).map((d) => '/' + d.name).sort();
		expect(SITE_TABS.map(([t]) => t).filter(Boolean).sort()).toEqual(pages);
		expect(existsSync(join(dir, '+page.svelte'))).toBe(true); // the Overview tab ('')
	});
	it('labels and explanations are unique and real sentences', () => {
		expect(new Set(SITE_TABS.map(([, l]) => l)).size).toBe(SITE_TABS.length);
		expect(new Set(SITE_TABS.map(([, , e]) => e)).size).toBe(SITE_TABS.length);
		for (const [, label, about] of SITE_TABS) { expect(about.length, label).toBeGreaterThan(30); expect(about.endsWith('.'), label).toBe(true); }
	});
	it('the layouts use these lists, and the static page title is gone so there is only one <title>', () => {
		expect(readFileSync('src/routes/+layout.svelte', 'utf8')).toMatch(/<title>\{pageTitle\(page\.url\.pathname\)\}<\/title>/);
		expect(readFileSync('src/routes/sites/[id]/+layout.svelte', 'utf8')).toMatch(/SITE_TABS as tabs/);
		expect(readFileSync('src/app.html', 'utf8')).not.toMatch(/<title>/);
	});
});
