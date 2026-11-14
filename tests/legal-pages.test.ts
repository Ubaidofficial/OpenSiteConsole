import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { GOOGLE_LIMITED_USE, privacySections, termsSections, type LegalContext } from '../src/lib/legal';

/**
 * The legal pages are written for a solo operator running the app themselves. These checks keep the claims in them true to the
 * code and licence, and keep what Google's verification looks for (a named operator, a contact, Limited Use, links from the
 * website and from the connect button) from quietly disappearing. They are not legal advice.
 */
const named: LegalContext = { entity: 'Jane Doe trading as Example', contact: 'support@example.com', law: 'England and Wales', updated: '2026-11-14' };
const text = (s: ReturnType<typeof privacySections>) => s.map((x) => [x.title, ...x.paras, ...(x.items ?? [])].join(' ')).join('\n');

describe('privacy policy', () => {
	const priv = text(privacySections(named));
	it('names the operator and a contact', () => {
		expect(priv).toContain('Jane Doe trading as Example');
		expect(priv).toContain('support@example.com');
	});
	it('carries Google\'s Limited Use statement word for word, and says how to revoke and delete', () => {
		expect(priv).toContain(GOOGLE_LIMITED_USE);
		expect(priv).toContain('https://myaccount.google.com/permissions');
		expect(privacySections(named).map((s) => s.title)).toEqual(expect.arrayContaining(['How long we keep it', 'Your choices and rights', 'Cookies and local storage', 'Children']));
	});
	it('says where Google data reaches an AI service, and that it is not used to train AI models', () => {
		expect(priv).toMatch(/Ask chat[^.]*Anthropic/);
		expect(priv).toMatch(/not use it to train AI models/);
		expect(priv).toMatch(/AI answer tracking[^.]*OpenAI[^.]*Perplexity[^.]*DataForSEO/);
	});
	it('says nothing is sold', () => {
		expect(priv).toMatch(/do not sell your data/);
	});
});

describe('terms', () => {
	const terms = text(termsSections(named));
	it('names the licence the project really has (AGPL-3.0, as in LICENSE and package.json), not another', () => {
		const lic = readFileSync('LICENSE', 'utf8').split('\n')[0];
		const pkg = JSON.parse(readFileSync('package.json', 'utf8')).license as string;
		expect(lic).toContain('AFFERO');
		expect(pkg).toBe('AGPL-3.0-only');
		expect(terms).toContain('AGPL-3.0-only');
		expect(terms).not.toMatch(/\bMIT\b/);
	});
	it('covers AI features, acceptable use, no warranty, liability and governing law', () => {
		expect(termsSections(named).map((s) => s.title)).toEqual(expect.arrayContaining(['AI features', 'Acceptable use', 'No warranty', 'Limit of liability', 'Governing law and changes to these terms']));
		expect(terms).toContain('England and Wales');
	});
	it('still reads sensibly before the operator has filled anything in', () => {
		const anon = text(termsSections({ entity: 'the operator of this SEOConsole installation', contact: null, law: null, updated: '2026-11-14' }));
		expect(anon).toContain('the operator of this SEOConsole installation');
		expect(anon).not.toContain('null');
		expect(anon).not.toContain('undefined');
	});
});

describe('where the pages are linked from', () => {
	it('the website footer links to both, because Google checks the homepage for a privacy policy', () => {
		const html = readFileSync('site/index.html', 'utf8');
		expect(html).toContain('href="https://app.seoconsole.app/privacy"');
		expect(html).toContain('href="https://app.seoconsole.app/terms"');
	});
	it('the connect button on the Accounts page sits under a line linking both', () => {
		const page = readFileSync('src/routes/accounts/+page.svelte', 'utf8');
		expect(page.indexOf('href="/terms"')).toBeGreaterThan(page.indexOf('/auth/connect'));
		expect(page).toContain('href="/privacy"');
	});
});
