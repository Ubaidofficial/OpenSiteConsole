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

const codePoint = (n: number) => (n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '�');
export const decode = (s: string) =>
	s
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&#(\d{1,8});/g, (_m, n) => codePoint(Number(n)))
		.replace(/&#x([0-9a-f]{1,6});/gi, (_m, n) => codePoint(parseInt(n, 16)))
		.replace(/\s+/g, ' ')
		.trim();

/** ASCII-only lower-casing keeps every index aligned with the original string (toLowerCase can change its length). */
export const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

const MAX_TAG = 20_000;

/**
 * Everything below scans with indexOf, never with a regex that can backtrack: a page made of thousands of unterminated
 * "<!--", "<h1>" or "<meta" must cost time proportional to its size, not its size squared. Where something is unterminated
 * the scan simply stops.
 */
export function stripInert(html: string): string {
	const lower = asciiLower(html);
	const next: Record<'c' | 's' | 'y', number> = { c: -2, s: -2, y: -2 }; // -2 unknown, -1 none left
	const nextOf = (k: 'c' | 's' | 'y', needle: string, from: number) => {
		let p = next[k];
		if (p === -2 || (p !== -1 && p < from)) p = next[k] = lower.indexOf(needle, from);
		return p;
	};
	let out = '';
	let pos = 0;
	for (;;) {
		const c = nextOf('c', '<!--', pos);
		const s = nextOf('s', '<script', pos);
		const y = nextOf('y', '<style', pos);
		const found = [c, s, y].filter((x) => x >= 0);
		if (!found.length) return out + html.slice(pos);
		const at = Math.min(...found);
		out += html.slice(pos, at);
		if (at === c) {
			const e = lower.indexOf('-->', at + 4);
			if (e < 0) return out;
			pos = e + 3;
		} else {
			const e = lower.indexOf(at === s ? '</script' : '</style', at);
			const gt = e < 0 ? -1 : lower.indexOf('>', e);
			if (gt < 0) return out;
			pos = gt + 1;
		}
	}
}

/** End index of the tag starting at `i`, honouring quoted attribute values (a ">" inside quotes does not end it). -1 if unterminated. */
function tagEnd(html: string, i: number): number {
	let quote = '';
	const stop = Math.min(html.length, i + MAX_TAG);
	for (let k = i + 1; k < stop; k++) {
		const ch = html[k];
		if (quote) {
			if (ch === quote) quote = '';
		} else if (ch === '"' || ch === "'") quote = ch;
		else if (ch === '>') return k;
	}
	return -1;
}

/** Opening tags named `name`, as strings, in document order. */
function* openTags(html: string, lower: string, name: string): Generator<{ tag: string; start: number; end: number }> {
	const needle = '<' + name;
	let from = 0;
	for (;;) {
		const i = lower.indexOf(needle, from);
		if (i < 0) return;
		const after = lower.charCodeAt(i + needle.length);
		const e = tagEnd(html, i);
		if (e < 0) return;
		if (after === 62 || after === 47 || after === 32 || after === 9 || after === 10 || after === 13) yield { tag: html.slice(i, e + 1), start: i, end: e };
		from = e + 1;
	}
}

/** Inner text of every <name>...</name> element; an element with no closing tag ends the scan. */
function elementTexts(html: string, lower: string, name: string, max = 20): string[] {
	const out: string[] = [];
	for (const t of openTags(html, lower, name)) {
		const close = lower.indexOf('</' + name, t.end + 1);
		if (close < 0) break;
		out.push(html.slice(t.end + 1, close));
		if (out.length >= max) break;
	}
	return out;
}

/**
 * Replace every <...> with a space, in one pass. (The regex /<[^>]*>/g does the same but takes quadratic time on a page that is
 * mostly "<" with no ">": 80,000 of them took 4.5 seconds, and a 1.4 MB page would block the whole server for minutes.)
 */
export function stripTags(s: string): string {
	let out = '';
	let i = 0;
	for (;;) {
		const lt = s.indexOf('<', i);
		if (lt < 0) return decode(out + s.slice(i));
		const gt = s.indexOf('>', lt + 1);
		if (gt < 0) return decode(out + s.slice(i)); // no ">" anywhere after: the rest is plain text
		out += s.slice(i, lt) + ' ';
		i = gt + 1;
	}
}

/** Attribute value of a tag, whichever order the attributes are in. */
export function attr(tag: string, name: string): string | null {
	const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
	return m ? decode(m[2] ?? m[3] ?? m[4] ?? '') : null;
}

function metaContent(html: string, lower: string, key: 'name' | 'property', value: string): string | null {
	for (const t of openTags(html, lower, 'meta')) if (attr(t.tag, key)?.toLowerCase() === value) return attr(t.tag, 'content');
	return null;
}

export function parseOnPage(rawHtml: string): Parsed {
	const html = stripInert(rawHtml.slice(0, 1_500_000));
	const lower = asciiLower(html);
	const head = html.slice(0, 400_000);
	const headLower = lower.slice(0, 400_000);
	const title = elementTexts(head, headLower, 'title', 1)[0];
	let canonical: string | null = null;
	for (const t of openTags(head, headLower, 'link')) if (attr(t.tag, 'rel')?.toLowerCase().split(/\s+/).includes('canonical')) { canonical = attr(t.tag, 'href'); break; }
	const htmlTag = openTags(head, headLower, 'html').next().value;
	return {
		title: title !== undefined ? stripTags(title) || null : null,
		description: metaContent(head, headLower, 'name', 'description'),
		h1: elementTexts(html, lower, 'h1').map(stripTags).filter(Boolean),
		canonical,
		robots: metaContent(head, headLower, 'name', 'robots'),
		lang: htmlTag ? attr(htmlTag.tag, 'lang') : null,
		ogTitle: metaContent(head, headLower, 'property', 'og:title')
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
	// Only a query that earns clicks says what people want from the page. A page whose "top" query has 0 clicks (an off-topic or one-off
	// search, say "nat eliason net worth" on a book page) is not told to rewrite its title around it.
	const top = cov[0] && cov[0].clicks > 0 ? cov[0] : undefined;
	if (top && top.title === 'none' && top.h1 === 'none') add('top-query-missing', 'warn', `Its top query "${top.query}" appears in neither the title nor the H1.`);
	else if (top && top.title === 'none') add('top-query-not-in-title', 'info', `Its top query "${top.query}" is not in the title.`);
	return { parsed, queries: cov, issues };
}

/**
 * Why a page that was just fetched is not fit to be crawled or asked about, or null when it looks fine: it is gone or erroring, it carries
 * a noindex, or it is an "unavailable" placeholder that answers 200 (a database that is reconnecting, maintenance mode). Found on a live
 * site whose job pages all said "temporarily unavailable" with a noindex for hours, which nothing in Search Console shows until Google recrawls.
 */
export function pageProblem(status: number, html: string | null): string | null {
	if (status === 404 || status === 410) return `The page answers ${status}: it is gone.`;
	if (status >= 500) return `The page answers ${status}: the server is failing.`;
	if (status >= 400) return `The page answers ${status}.`;
	if (!html) return null;
	const parsed = parseOnPage(html);
	if (parsed.robots && /noindex/i.test(parsed.robots)) return 'It carries a noindex tag.';
	// What a placeholder says is short and plain, in the first part of its title ("Companies temporarily unavailable | Site") or its heading.
	// An article about outages ("Why is my site temporarily unavailable? Fixes") is not one: it asks a question or has several words first.
	const lead = (t: string) => t.split(/\s[|\u2013\u2014\u00b7-]\s/)[0].trim();
	const looksDown = (t: string) => {
		const x = lead(t);
		if (!x || x.includes('?') || x.length > 70) return false;
		const m = /\b(temporarily|currently)\s+(unavailable|down)\b|\bservice unavailable\b|\bunder maintenance\b|\bmaintenance mode\b|\bbe right back\b/i.exec(x);
		return !!m && x.slice(0, m.index).trim().split(/\s+/).filter(Boolean).length <= 3;
	};
	if (looksDown(parsed.title ?? '') || parsed.h1.some(looksDown)) return 'The page says it is temporarily unavailable.';
	return null;
}

/** 0-100: starts at 100, bad -25, warn -10, info -3, floor 0. A relative ranking aid, not a Google measure. */
export function onPageScore(issues: Issue[]): number {
	return Math.max(0, 100 - issues.reduce((a, i) => a + (i.severity === 'bad' ? 25 : i.severity === 'warn' ? 10 : 3), 0));
}
