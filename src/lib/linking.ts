/**
 * Internal-link suggestions: which of your pages should link to a page that is close to ranking better, and with which words.
 * Pure functions, unit-tested; the crawl and the storage are in src/lib/server/internallinks.ts.
 *
 * 1. extractPage reads one fetched page: its title, H1, the text of its main content (navigation, header, footer, asides, forms
 *    and scripts left out; headings left out too, because a link belongs in a sentence) and every link to the same site.
 * 2. findMention looks for a search query in that text: the words together and in order (whole words, any case, a plural
 *    folded), or failing that all its meaningful words close together in one sentence. It returns the words as the page
 *    writes them (the anchor to use) and the sentence they are in.
 * 3. suggestLinks pairs each target page with the crawled pages that mention one of its queries and do not link to it yet,
 *    scored by the prize of the query x how exact the mention is x the source page's own search traffic.
 * No JavaScript is run, so a page that builds its content in the browser reads as nearly empty.
 */
import { asciiLower, attr, decode, stripInert } from './onpage';
import { normalizeUrl } from './analytics';

// ── reading a page ───────────────────────────────────────────────────────────

export interface PageLink {
	/** absolute URL, fragment removed */
	url: string;
	/** the link text (or the alt text of an image inside the link) */
	anchor: string;
	/** inside nav, header, footer or aside: a site-wide link rather than one in the content */
	chrome: boolean;
}
export interface ExtractedPage {
	title: string | null;
	h1: string | null;
	/** the main content's text, one paragraph (or list item, cell...) per line, headings left out */
	text: string;
	links: PageLink[];
}

/** Left out of the text entirely (their links are still read). */
const SKIP = new Set(['nav', 'header', 'footer', 'aside', 'noscript', 'template', 'svg', 'form', 'button', 'select', 'iframe', 'dialog', 'object', 'canvas', 'textarea']);
const CHROME = new Set(['nav', 'header', 'footer', 'aside']);
const HEADING = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
/** Tags that end a run of text (a paragraph, a list item, a cell...). */
const BLOCK = new Set(['p', 'div', 'li', 'br', 'tr', 'td', 'th', 'section', 'article', 'blockquote', 'ul', 'ol', 'table', 'dd', 'dt', 'dl', 'figcaption', 'figure', 'pre', 'main', 'body', 'hr', 'details', 'summary', 'caption', 'address', ...HEADING, ...SKIP]);
const MAX_TEXT = 60_000;
const MAX_LINKS = 1_000;
const MAX_ATTR_TAG = 20_000;

/** The link's absolute URL on the same site (same host, www ignored), or null for anything else (mail, script, other sites, bad URLs). */
export function resolveLink(href: string | null, base: string): string | null {
	const h = (href ?? '').trim();
	if (!h || h.startsWith('#') || /^(mailto|tel|javascript|data|sms|ftp):/i.test(h)) return null;
	try {
		const u = new URL(h, base);
		if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
		const host = (x: string) => x.toLowerCase().replace(/^www\./, '');
		if (host(u.hostname) !== host(new URL(base).hostname)) return null;
		u.hash = '';
		return u.href;
	} catch {
		return null;
	}
}

/**
 * Read a page in one pass over its tags (no regex that can backtrack, so a hostile page costs time in proportion to its size).
 * If the page has a <main> element only that is read as content; otherwise everything in <body> outside nav, header, footer,
 * asides and forms. Links are read from the whole page, flagged when they sit in the site-wide parts.
 */
export function extractPage(rawHtml: string, pageUrl: string): ExtractedPage {
	const html = stripInert(rawHtml.slice(0, 1_500_000));
	const lower = asciiLower(html);
	const hasMain = /<main[\s>]/.test(lower);
	let base = pageUrl;
	let title: string | null = null;
	let h1: string | null = null;
	const blocks: string[] = [];
	let textLen = 0;
	const links: PageLink[] = [];
	const depth: Record<string, number> = {};
	let skip = 0;
	let chrome = 0;
	let heading = 0;
	let main = 0;
	let inTitle = false;
	let titleBuf = '';
	let h1Buf: string | null = null;
	let cur = '';
	let link: { url: string | null; buf: string; alt: string; chrome: boolean } | null = null;
	const flush = () => {
		const t = decode(cur);
		cur = '';
		if (t && textLen < MAX_TEXT) {
			blocks.push(t);
			textLen += t.length + 1;
		}
	};
	const endLink = () => {
		if (!link) return;
		const anchor = decode(link.buf) || decode(link.alt);
		if (link.url && links.length < MAX_LINKS) links.push({ url: link.url, anchor: anchor.slice(0, 200), chrome: link.chrome });
		link = null;
	};
	const text = (s: string) => {
		if (!s) return;
		if (inTitle) titleBuf += s;
		if (h1Buf !== null) h1Buf += s;
		if (link) link.buf += s;
		if (skip === 0 && heading === 0 && (!hasMain || main > 0)) cur += s;
	};
	let i = 0;
	for (;;) {
		const lt = html.indexOf('<', i);
		if (lt < 0) {
			text(html.slice(i));
			break;
		}
		text(html.slice(i, lt));
		const gt = html.indexOf('>', lt + 1);
		if (gt < 0) {
			text(html.slice(lt)); // no ">" anywhere after: the rest is plain text
			break;
		}
		i = gt + 1;
		const tag = html.slice(lt, gt + 1);
		const m = /^<(\/?)([a-z][a-z0-9-]*)/.exec(lower.slice(lt, Math.min(gt + 1, lt + 40)));
		if (!m) continue; // a comment remnant, a doctype or a stray "<"
		const closing = m[1] === '/';
		const name = m[2];
		const selfClosing = tag.endsWith('/>');
		if (BLOCK.has(name)) flush();
		if (name === 'title') {
			if (!closing) inTitle = title === null;
			else if (inTitle) {
				title = decode(titleBuf) || null;
				inTitle = false;
			}
			continue;
		}
		if (name === 'base' && !closing && base === pageUrl && tag.length < MAX_ATTR_TAG) {
			const b = attr(tag, 'href');
			try {
				if (b) base = new URL(b, pageUrl).href;
			} catch {
				/* a bad <base>: keep the page URL */
			}
			continue;
		}
		if (name === 'a') {
			endLink(); // an <a> never contains another: an unclosed one ends here
			if (!closing && !selfClosing) link = { url: tag.length < MAX_ATTR_TAG ? resolveLink(attr(tag, 'href'), base) : null, buf: '', alt: '', chrome: chrome > 0 };
			continue;
		}
		if (name === 'img' && link && !link.alt && tag.length < MAX_ATTR_TAG) {
			link.alt = attr(tag, 'alt') ?? '';
			continue;
		}
		if (selfClosing) continue;
		const delta = closing ? -1 : 1;
		if (closing && !(depth[name] > 0)) continue; // a close tag with no open one
		depth[name] = (depth[name] ?? 0) + delta;
		if (SKIP.has(name)) skip += delta;
		if (CHROME.has(name)) chrome += delta;
		if (name === 'main') main += delta;
		if (HEADING.has(name)) {
			heading += delta;
			if (name === 'h1') {
				if (!closing && h1 === null && h1Buf === null) h1Buf = '';
				else if (closing && h1Buf !== null) {
					h1 = decode(h1Buf) || null;
					h1Buf = null;
				}
			}
		}
	}
	endLink();
	flush();
	return { title, h1, text: blocks.join('\n').slice(0, MAX_TEXT), links };
}

// ── finding a query in the text ──────────────────────────────────────────────

const STOP = new Set('a an and are as at be by for from how i in is it of on or the to was what when where which who why with you your vs near me'.split(' '));
/** A word as compared: lower case, a trailing "'s" and a plural "s" folded ("tool" matches "Tools" and "tool's"). */
export const fold = (w: string) => {
	const x = w.toLowerCase().replace(/['’]s$/, '');
	return x.length > 3 && x.endsWith('s') && !x.endsWith('ss') ? x.slice(0, -1) : x;
};

interface Tok { w: string; start: number; end: number }
const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;
export function tokens(s: string): Tok[] {
	const out: Tok[] = [];
	for (const m of s.matchAll(WORD)) out.push({ w: fold(m[0]), start: m.index!, end: m.index! + m[0].length });
	return out;
}

export type MentionKind = 'exact' | 'words';
export interface Mention {
	kind: MentionKind;
	/** the words exactly as the page writes them: the anchor text to use */
	anchor: string;
	/** the sentence they are in (shortened around the anchor if it is long) */
	snippet: string;
}

/** Between two words of a phrase only spaces and hyphens may stand (a full stop or a comma breaks it). */
const joins = (s: string) => /^[\s \-‐‑–]*$/.test(s);
/** Between two words of a near match: anything but the end of a sentence. */
const sameSentence = (s: string) => !/[.!?;:]/.test(s);

/** The sentence of `line` around [start, end), at most about `max` characters. */
export function sentenceAround(line: string, start: number, end: number, max = 220): string {
	let a = start;
	while (a > 0 && !(/[.!?]/.test(line[a - 1]) && /\s/.test(line[a] ?? ' '))) a--;
	let b = end;
	while (b < line.length && !(/[.!?]/.test(line[b]) && (b + 1 >= line.length || /\s/.test(line[b + 1])))) b++;
	if (b < line.length) b++;
	let s = line.slice(a, b).trim();
	if (s.length > max) {
		const off = start - a - (line.slice(a, b).length - line.slice(a, b).trimStart().length);
		const from = Math.max(0, Math.min(off - Math.floor((max - (end - start)) / 2), s.length - max));
		s = (from > 0 ? '…' : '') + s.slice(from, from + max).trim() + (from + max < s.length ? '…' : '');
	}
	return s;
}

/** The query's words, folded; and the meaningful ones (no stop words). */
export function queryWords(query: string): { all: string[]; key: string[] } {
	const all = tokens(query).map((t) => t.w);
	return { all, key: [...new Set(all.filter((w) => !STOP.has(w)))] };
}

/**
 * Where `query` appears in `text` (one paragraph per line): the exact phrase first, in the first line that has it; otherwise all
 * its meaningful words within a few words of each other in one sentence (only when those are three or more, or all of the query's
 * words: a one-word query, or "what is X", never matches loosely). `skipAnchors` are link texts already on the page: a phrase that is already a link is not
 * offered again.
 */
export function findMention(text: string, query: string, skipAnchors: Set<string> = new Set()): Mention | null {
	const q = queryWords(query);
	if (!q.all.length || !q.key.length) return null;
	const n = q.all.length;
	const lines = text.split('\n');
	let near: Mention | null = null;
	for (const line of lines) {
		const t = tokens(line);
		// exact: the query's words, consecutive, joined only by spaces or hyphens
		for (let i = 0; i + n <= t.length; i++) {
			let ok = true;
			for (let k = 0; k < n && ok; k++) ok = t[i + k].w === q.all[k] && (k === 0 || joins(line.slice(t[i + k - 1].end, t[i + k].start)));
			if (!ok) continue;
			const anchor = line.slice(t[i].start, t[i + n - 1].end);
			if (skipAnchors.has(anchor.toLowerCase())) continue;
			return { kind: 'exact', anchor, snippet: sentenceAround(line, t[i].start, t[i + n - 1].end) };
		}
		// Loose matches only when the query's meaningful words carry it: three or more, or all of its words (a reordering). "what is
		// garden tools" would otherwise match every sentence that says "garden tools", which is the topic, not that search.
		if (near || q.key.length < 2 || (q.key.length < 3 && q.key.length < q.all.length)) continue;
		// near: every meaningful word within n + 3 words, in one sentence; the shortest such span wins
		const window = n + 3;
		let best: [number, number] | null = null;
		for (let i = 0; i < t.length; i++) {
			if (!q.key.includes(t[i].w)) continue;
			const seen = new Set([t[i].w]);
			for (let j = i + 1; j < t.length && j - i < window; j++) {
				if (!sameSentence(line.slice(t[j - 1].end, t[j].start))) break;
				if (q.key.includes(t[j].w)) seen.add(t[j].w);
				if (seen.size === q.key.length) {
					if (!best || j - i < best[1] - best[0]) best = [i, j];
					break;
				}
			}
		}
		if (best) {
			const anchor = line.slice(t[best[0]].start, t[best[1]].end);
			if (!skipAnchors.has(anchor.toLowerCase())) near = { kind: 'words', anchor, snippet: sentenceAround(line, t[best[0]].start, t[best[1]].end) };
		}
	}
	return near;
}

// ── pairing targets with sources ─────────────────────────────────────────────

export interface TargetQuery { query: string; position: number; impressions: number; clicks: number; /** est. extra clicks per period at position 3 */ prize: number }
export interface LinkTarget {
	page: string;
	/** other URLs that are the same page (where it redirects to) */
	aliases?: string[];
	queries: TargetQuery[];
	/** the sum of its queries' prizes */
	prize: number;
}
export interface SourcePage {
	url: string;
	finalUrl: string;
	text: string;
	links: PageLink[];
	clicks: number;
	impressions: number;
}
export interface Suggestion {
	/** stable: the source and target, normalised (what "done" is stored against) */
	key: string;
	source: string;
	target: string;
	query: string;
	anchor: string;
	snippet: string;
	match: MentionKind;
	/** the query's prize: est. extra clicks per period if the target reached position 3 (a link alone will not do that) */
	prize: number;
	position: number;
	sourceClicks: number;
	sourceImpressions: number;
	score: number;
}

export const MATCH_WEIGHT: Record<MentionKind, number> = { exact: 1, words: 0.6 };

/** How much a link from this page is likely to count: grows with the page's own clicks and impressions, slowly (log). At least 1. */
export const authority = (clicks: number, impressions: number) => 1 + Math.log10(1 + Math.max(0, clicks)) + 0.5 * Math.log10(1 + Math.max(0, impressions) / 100);

/** prize x match weight x source authority: the order suggestions are listed in. */
export const suggestionScore = (o: { prize: number; match: MentionKind; sourceClicks: number; sourceImpressions: number }) => o.prize * MATCH_WEIGHT[o.match] * authority(o.sourceClicks, o.sourceImpressions);

export const suggestionKey = (source: string, target: string) => `${normalizeUrl(source)}>${normalizeUrl(target)}`;

/**
 * For each target, the crawled pages that mention one of its queries and do not already link to it (any link counts, menus too),
 * best first; at most `perTarget` per target and one per source (its best query). All of them, best first, up to `limit`.
 */
export function suggestLinks(targets: LinkTarget[], sources: SourcePage[], o: { perTarget?: number; limit?: number; queriesPerTarget?: number } = {}): Suggestion[] {
	const { perTarget = 5, limit = 300, queriesPerTarget = 5 } = o;
	// Each source's words, once: a query whose meaningful words are not all on the page cannot match, so most pairs are skipped cheaply.
	const prepared = sources
		.filter((s) => s.text)
		.map((s) => ({
			s,
			self: new Set([normalizeUrl(s.url), normalizeUrl(s.finalUrl)]),
			linksTo: new Set(s.links.map((l) => normalizeUrl(l.url))),
			anchors: new Set(s.links.map((l) => l.anchor.toLowerCase()).filter(Boolean)),
			words: new Set(tokens(s.text).map((t) => t.w))
		}));
	const out: Suggestion[] = [];
	for (const t of targets) {
		const same = new Set([t.page, ...(t.aliases ?? [])].map(normalizeUrl));
		const queries = [...t.queries].sort((a, b) => b.prize - a.prize).slice(0, queriesPerTarget).map((q) => ({ q, w: queryWords(q.query) }));
		const found: Suggestion[] = [];
		for (const p of prepared) {
			if ([...p.self].some((u) => same.has(u))) continue; // the target itself
			if ([...same].some((u) => p.linksTo.has(u))) continue; // already links to it
			let best: Suggestion | null = null;
			for (const { q, w } of queries) {
				if (!w.key.length || !w.key.every((x) => p.words.has(x))) continue;
				const m = findMention(p.s.text, q.query, p.anchors);
				if (!m) continue;
				const sc = suggestionScore({ prize: q.prize, match: m.kind, sourceClicks: p.s.clicks, sourceImpressions: p.s.impressions });
				if (!best || sc > best.score) best = { key: suggestionKey(p.s.url, t.page), source: p.s.url, target: t.page, query: q.query, anchor: m.anchor, snippet: m.snippet, match: m.kind, prize: q.prize, position: q.position, sourceClicks: p.s.clicks, sourceImpressions: p.s.impressions, score: sc };
			}
			if (best) found.push(best);
		}
		found.sort((a, b) => b.score - a.score || b.sourceClicks - a.sourceClicks || a.source.localeCompare(b.source));
		out.push(...found.slice(0, perTarget));
	}
	return out.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key)).slice(0, limit);
}

/**
 * Pages that earn impressions but that no crawled page links to (a page's link to itself does not count). Only as good as the
 * crawl: with a partial crawl a page can be linked from a page that was not fetched. The home page is left out: people and
 * Google reach it from outside.
 */
export function orphanPages<T extends { page: string; impressions: number }>(pages: T[], sources: Pick<SourcePage, 'url' | 'finalUrl' | 'links'>[]): T[] {
	const linked = new Set<string>();
	for (const s of sources) {
		const self = new Set([normalizeUrl(s.url), normalizeUrl(s.finalUrl)]);
		for (const l of s.links) {
			const u = normalizeUrl(l.url);
			if (!self.has(u)) linked.add(u);
		}
	}
	return pages.filter((p) => {
		const u = normalizeUrl(p.page);
		return !u.endsWith('/') && u.includes('/') && !linked.has(u);
	}).sort((a, b) => b.impressions - a.impressions);
}
