/**
 * Sitemap parsing, pure and linear: a hostile or broken sitemap (thousands of unterminated tags, a huge file) costs time
 * proportional to its size, never its size squared. Handles <urlset> and <sitemapindex>, CDATA, entities and lastmod.
 */
import { decode } from './onpage';

export const MAX_ENTRIES_PER_FILE = 50_000; // the sitemap protocol's own limit

export interface SitemapEntry { loc: string; lastmod: string | null }
export interface ParsedSitemap { kind: 'index' | 'urlset' | 'unknown'; entries: SitemapEntry[]; truncated: boolean }

/**
 * Lower-case A-Z only, keeping every index aligned with the original. toLowerCase is far faster (a 40 MB file of capitals took
 * 6 s with a callback per letter) and keeps the length unless a character expands (an upper-case I with a dot becomes two units),
 * in which case alignment is not guaranteed and the slow, exact version is used.
 */
const asciiLower = (s: string) => {
	const l = s.toLowerCase();
	return l.length === s.length ? l : s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
};

/** Text of the first <tag>…</tag> inside xml[from, to), without CDATA wrappers; null if absent. */
function inner(xml: string, lower: string, tag: string, from: number, to: number): string | null {
	// Search only inside this entry. indexOf on the whole document would scan to its END whenever the tag is absent from the
	// entry (many sitemaps have no <lastmod>), which made a 50,000-URL file take 40 seconds.
	const seg = lower.slice(from, to);
	const o = seg.indexOf('<' + tag);
	if (o < 0) return null;
	const g = seg.indexOf('>', o);
	if (g < 0) return null;
	const c = seg.indexOf('</' + tag, g);
	if (c < 0) return null;
	let t = xml.slice(from + g + 1, from + c).trim();
	const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(t);
	if (cdata) t = cdata[1].trim();
	return decode(t);
}

export function parseSitemapXml(xml: string): ParsedSitemap {
	const lower = asciiLower(xml);
	const kind = lower.includes('<sitemapindex') ? 'index' : lower.includes('<urlset') ? 'urlset' : 'unknown';
	if (kind === 'unknown') return { kind, entries: [], truncated: false };
	const tag = kind === 'index' ? 'sitemap' : 'url';
	const entries: SitemapEntry[] = [];
	let from = 0;
	for (;;) {
		const open = lower.indexOf('<' + tag, from);
		if (open < 0) break;
		const after = lower.charCodeAt(open + tag.length + 1);
		const isTag = after === 62 || after === 32 || after === 9 || after === 10 || after === 13; // "<url>" or "<url " but not "<urlset"
		// A false match ("<urlset", "<sitemapindex") must be skipped WITHOUT jumping to the next closing tag: that would swallow
		// the first real entry (this dropped one URL from a real sitemap).
		if (!isTag) {
			from = open + 1;
			continue;
		}
		const close = lower.indexOf('</' + tag + '>', open);
		if (close < 0) break; // an unterminated element ends the scan
		const loc = inner(xml, lower, 'loc', open, close);
		if (loc && loc.length <= 2048 && /^https?:\/\/\S+$/i.test(loc)) {
			const lm = inner(xml, lower, 'lastmod', open, close);
			entries.push({ loc, lastmod: lm && /^\d{4}-\d{2}-\d{2}/.test(lm) ? lm.slice(0, 10) : null });
			if (entries.length >= MAX_ENTRIES_PER_FILE) return { kind, entries, truncated: lower.indexOf('<' + tag, close) >= 0 };
		}
		from = close + tag.length + 3;
	}
	return { kind, entries, truncated: false };
}
