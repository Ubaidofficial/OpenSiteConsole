import { beforeEach, describe, expect, it } from 'vitest';
import { bareName, coverageMap, isRootPrefix, propertyLabel } from '../src/lib/property';
import { db, openDb } from '../src/lib/server/db';
import { portfolioTotals, siteCards } from '../src/lib/server/queries';
import { hideCoveredDuplicates, hideableDuplicates } from '../src/lib/server/duplicates';
import { portfolioStriking } from '../src/lib/server/portfolio';

describe('property labels', () => {
	it('tells a Domain property from a URL-prefix property of the same site', () => {
		expect(propertyLabel('sc-domain:example-consulting.example')).toBe('example-consulting.example');
		expect(propertyLabel('https://example-consulting.example/')).toBe('example-consulting.example (URL prefix)');
		expect(propertyLabel('https://www.example-consulting.example/blog/')).toBe('www.example-consulting.example/blog (URL prefix)');
		expect(propertyLabel('http://old.example.com/')).toBe('http://old.example.com (URL prefix)');
		expect(bareName('https://example-consulting.example/')).toBe('example-consulting.example');
	});
	it('detects root vs sub-path prefixes', () => {
		expect(isRootPrefix('https://a.com/')).toBe(true);
		expect(isRootPrefix('https://a.com/blog/')).toBe(false);
		expect(isRootPrefix('sc-domain:a.com')).toBe(false);
	});
	it('maps URL-prefix properties to the covering Domain property (www and subdomains included)', () => {
		const sites = [
			{ id: 1, site_url: 'sc-domain:a.com' },
			{ id: 2, site_url: 'https://a.com/' },
			{ id: 3, site_url: 'https://www.a.com/' },
			{ id: 4, site_url: 'https://blog.a.com/x/' },
			{ id: 5, site_url: 'https://b.com/' },
			{ id: 6, site_url: 'sc-domain:blog.a.com' }
		];
		const m = coverageMap(sites);
		expect(m.get(2)).toBe(1);
		expect(m.get(3)).toBe(1);
		expect(m.get(4)).toBe(1); // first matching domain; both a.com and blog.a.com cover it
		expect(m.has(5)).toBe(false);
		expect(m.has(1)).toBe(false); // a Domain property is never "covered"
		expect(m.has(6)).toBe(false); // nor a sub-domain Domain property
	});
});

describe('totals count each site once', () => {
	beforeEach(() => {
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		const d = db();
		d.prepare("INSERT INTO accounts (id, google_sub, email, created_at) VALUES (1,'s','a@b.c',1)").run();
		const mk = (id: number, url: string) => {
			d.prepare("INSERT INTO sites (id, account_id, site_url, permission, synced_through, created_at) VALUES (?,1,?,'siteOwner','2026-11-03',1)").run(id, url);
			d.prepare('INSERT INTO site_daily VALUES (?,?,?,?,?)').run(id, '2026-11-03', 10, 100, 5);
		};
		mk(1, 'sc-domain:example-consulting.example');
		mk(2, 'https://example-consulting.example/'); // same traffic, already inside the Domain property
		mk(3, 'sc-domain:other.com');
	});

	it('does not double count a URL-prefix property inside a Domain property', () => {
		const cards = siteCards(7);
		const t = portfolioTotals(cards);
		expect(cards).toHaveLength(3);
		expect(t.now.clicks).toBe(20); // 10 (domain) + 10 (other), not 30
		expect(t.duplicates).toBe(1);
		expect(cards.find((c) => c.site.id === 2)!.coveredBy).toBe(1);
	});

	it('hides only the redundant root-path duplicates, and then totals and cards agree', () => {
		expect(hideableDuplicates().map((d) => d.id)).toEqual([2]);
		expect(hideCoveredDuplicates()).toBe(1);
		const cards = siteCards(7);
		expect(cards.map((c) => c.site.id).sort()).toEqual([1, 3]);
		expect(portfolioTotals(cards).duplicates).toBe(0);
		expect(hideCoveredDuplicates()).toBe(0); // idempotent
	});

	it('portfolio analytics skip the covered property too', () => {
		const d = db();
		const ins = d.prepare("INSERT INTO sa_rows VALUES (?,'2026-11-03','best widget','https://example-consulting.example/p','usa','MOBILE',1,500,8)");
		ins.run(1);
		ins.run(2); // identical rows via the URL-prefix property
		const rows = portfolioStriking(28);
		expect(rows.filter((r) => r.query === 'best widget')).toHaveLength(1);
	});
});
