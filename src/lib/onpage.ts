/**
 * On-page SEO check: pull the title, meta description, H1 and a few head tags out of a page's HTML and test them
 * against the queries that page already ranks for. Pure functions, unit-tested. The parser is regex based on purpose
 * (no HTML dependency); it handles ordinary pages and will misread exotic markup, and it does not run JavaScript, so
 * a page that builds its title or H1 in the browser is read as missing them.
 */

export interface Parsed {
	title: string | null;
	description: string | null;
	h1: string[];
	canonical: string | null;
	robots: string | null;
	lang: string | null;
	ogTitle: string | null;
}

const decode = (s: string) =>
	s
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
		.replace(/\s+/g, ' ')
		.trim();
const stripTags = (s: string) => decode(s.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/gi, ' '));

/** Attribute value of a tag, whichever order the attributes are in. */
function attr(tag: string, name: string): string | null {
	const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
	return m ? decode(m[2] ?? m[3] ?? m[4] ?? '') : null;
}

function metaContent(html: string, key: 'name' | 'property', value: string): string | null {
	for (const m of html.matchAll(/<meta\b[^>]*>/gi)) if (attr(m[0], key)?.toLowerCase() === value) return attr(m[0], 'content');
	return null;
}

/** Scripts, styles and comments hold text that looks like markup but is not part of the page. */
const stripInert = (html: string) => html.replace(/<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi, '');

export function parseOnPage(rawHtml: string): Parsed {
	const html = stripInert(rawHtml.slice(0, 1_500_000));
	const head = html.slice(0, 400_000);
	const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(head);
	const canon = [...head.matchAll(/<link\b[^>]*>/gi)].find((m) => attr(m[0], 'rel')?.toLowerCase().split(/\s+/).includes('canonical'));
	const lang = /<html\b[^>]*>/i.exec(head);
	return {
		title: title ? stripTags(title[1]) || null : null,
		description: metaContent(head, 'name', 'description'),
		h1: [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) => stripTags(m[1])).filter(Boolean),
		canonical: canon ? attr(canon[0], 'href') : null,
		robots: metaContent(head, 'name', 'robots'),
		lang: lang ? attr(lang[0], 'lang') : null,
		ogTitle: metaContent(head, 'property', 'og:title')
	};
}

// ── Does text contain a query? ───────────────────────────────────────────────
const STOP = new Set('a an and are as at be by for from how i in is it of on or the to was what when where which who why with you your vs'.split(' '));
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const stem = (w: string) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);

export type Match = 'exact' | 'all-words' | 'some-words' | 'none';

/**
 * exact      the words appear together, in order (after lower-casing and dropping punctuation)
 * all-words  every meaningful word appears, in any order or position
 * some-words at least half of them do
 * none       otherwise
 * Plurals are folded ("tool" matches "tools"). Stop words are ignored for the word tests, not for the exact one.
 */
export function matchQuery(text: string | null | undefined, query: string): Match {
	if (!text) return 'none';
	const t = ` ${norm(text)} `;
	const q = norm(query);
	if (!q) return 'none';
	if (t.includes(` ${q} `)) return 'exact';
	const words = q.split(' ').filter((w) => !STOP.has(w)).map(stem);
	if (!words.length) return 'none';
	const have = new Set(norm(text).split(' ').map(stem));
	const hit = words.filter((w) => have.has(w)).length;
	return hit === words.length ? 'all-words' : hit >= Math.ceil(words.length / 2) ? 'some-words' : 'none';
}

// ── The checks ───────────────────────────────────────────────────────────────
export type Sev = 'bad' | 'warn' | 'info';
export interface Issue { id: string; severity: Sev; message: string }

export interface QueryCoverage { query: string; clicks: number; title: Match; description: Match; h1: Match }

export interface PageCheck {
	parsed: Parsed;
	queries: QueryCoverage[];
	issues: Issue[];
}

/**
 * Title length: about 60 characters and 155 for the description are folk rules. Google truncates by pixel width, not by
 * characters, so these are prompts to look at the snippet, never hard limits.
 */
export function checkPage(parsed: Parsed, queries: { query: string; clicks: number }[], o: { pageUrl?: string } = {}): PageCheck {
	const issues: Issue[] = [];
	const add = (id: string, severity: Sev, message: string) => issues.push({ id, severity, message });
	const { title, description, h1 } = parsed;
	if (!title) add('no-title', 'bad', 'No <title> found (if the page sets it with JavaScript, this check cannot see it).');
	else if (title.length > 65) add('long-title', 'info', `Title is ${title.length} characters; Google may cut it off in results.`);
	else if (title.length < 15) add('short-title', 'info', `Title is only ${title.length} characters.`);
	if (!description) add('no-description', 'warn', 'No meta description. Google will write its own snippet.');
	else if (description.length > 170) add('long-description', 'info', `Meta description is ${description.length} characters; it may be cut off.`);
	if (!h1.length) add('no-h1', 'warn', 'No <h1> found.');
	if (h1.length > 1) add('multi-h1', 'info', `${h1.length} <h1> elements.`);
	if (parsed.robots && /noindex/i.test(parsed.robots)) add('noindex', 'bad', `Meta robots says "${parsed.robots}": Google is told not to index this page.`);
	if (parsed.canonical && o.pageUrl) {
		try {
			if (new URL(parsed.canonical, o.pageUrl).href.replace(/\/$/, '') !== new URL(o.pageUrl).href.replace(/\/$/, '')) add('canonical-elsewhere', 'warn', `Canonical points to ${parsed.canonical}, not to this URL.`);
		} catch {
			/* unparsable canonical: ignore */
		}
	}
	if (!parsed.lang) add('no-lang', 'info', 'The <html> tag has no lang attribute.');
	const cov: QueryCoverage[] = queries.map((q) => ({ query: q.query, clicks: q.clicks, title: matchQuery(title, q.query), description: matchQuery(description, q.query), h1: matchQuery(h1.join(' '), q.query) }));
	const top = cov[0];
	if (top && top.title === 'none' && top.h1 === 'none') add('top-query-missing', 'warn', `Its top query "${top.query}" appears in neither the title nor the H1.`);
	else if (top && top.title === 'none') add('top-query-not-in-title', 'info', `Its top query "${top.query}" is not in the title.`);
	return { parsed, queries: cov, issues };
}

/** 0-100: starts at 100, bad -25, warn -10, info -3, floor 0. A relative ranking aid, not a Google measure. */
export function onPageScore(issues: Issue[]): number {
	return Math.max(0, 100 - issues.reduce((a, i) => a + (i.severity === 'bad' ? 25 : i.severity === 'warn' ? 10 : 3), 0));
}
