import { fetchBytes, hostAllowed } from './onpage';
import { config } from './config';

/**
 * A site's logo, fetched by this server from the site itself (never a third-party favicon service, which would learn which sites you
 * watch). Reuses fetchBytes, so it keeps the same-host rule and the private-address refusal. Hits are cached for a week, misses for
 * an hour; the image is checked by its first bytes, never by the Content-Type the site claims, and SVG that could run script is refused.
 */
export interface SiteIcon { body: Buffer; type: string }

const MAX_ICON = 256 * 1024;
const HIT_MS = 7 * 24 * 3600_000;
const MISS_MS = 3600_000;
const cache = new Map<string, { at: number; icon: SiteIcon | null }>();
const inflight = new Map<string, Promise<SiteIcon | null>>();

export interface IconCandidate { href: string; score: number }

/** The <link rel="icon"> candidates in a home page, best first: SVG, then the largest PNG, then anything else. Relative links resolve against `base`. */
export function iconCandidates(html: string, base: string): IconCandidate[] {
	const out: IconCandidate[] = [];
	for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
		const tag = m[0];
		const attr = (n: string) => new RegExp(`\\b${n}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
		const rel = attr('rel');
		const href = attr('href');
		const r = (rel?.[1] ?? rel?.[2] ?? rel?.[3] ?? '').toLowerCase().split(/\s+/);
		const h = (href?.[1] ?? href?.[2] ?? href?.[3] ?? '').trim();
		if (!h || !r.includes('icon') || r.includes('mask-icon') || /^data:/i.test(h)) continue;
		let url: string;
		try {
			url = new URL(h.replace(/&amp;/g, '&'), base).href;
		} catch {
			continue;
		}
		const sizes = (attr('sizes')?.[1] ?? attr('sizes')?.[2] ?? attr('sizes')?.[3] ?? '').toLowerCase();
		const type = (attr('type')?.[1] ?? attr('type')?.[2] ?? attr('type')?.[3] ?? '').toLowerCase();
		const px = Math.max(0, ...[...sizes.matchAll(/(\d+)x\d+/g)].map((s) => Number(s[1])));
		const isSvg = /svg/.test(type) || /\.svg(\?|#|$)/i.test(h);
		const isPng = /png/.test(type) || /\.png(\?|#|$)/i.test(h);
		out.push({ href: url, score: isSvg ? 1000 : isPng ? 500 + Math.min(px, 256) / 4 : 100 + Math.min(px, 256) / 8 });
	}
	return out.sort((a, b) => b.score - a.score);
}

/** What the bytes really are (PNG, JPEG, GIF, WebP, ICO, or safe SVG), or null. */
export function sniffIcon(body: Buffer): string | null {
	if (body.length < 4) return null;
	if (body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
	if (body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return 'image/jpeg';
	if (body.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
	if (body.subarray(0, 4).toString('latin1') === 'RIFF' && body.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
	if (body[0] === 0 && body[1] === 0 && body[2] === 1 && body[3] === 0) return 'image/x-icon';
	const head = body.subarray(0, 4096).toString('utf8').replace(/^﻿/, '');
	if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(head)) {
		const text = body.toString('utf8');
		// An SVG can carry script, event handlers, embedded HTML and external references; it is served with a sandbox CSP as well,
		// but an icon has no need for any of that, so such a file is simply not used.
		if (/<script|<foreignObject|<iframe|<embed|<object|\son[a-z]+\s*=|javascript:|<!ENTITY|<!DOCTYPE[^>]*\[|(?:href|src)\s*=\s*["'](?!#)/i.test(text)) return null;
		return 'image/svg+xml';
	}
	return null;
}

async function fetchIcon(siteUrl: string, fetchImpl?: typeof fetch): Promise<SiteIcon | null> {
	const origin = (() => {
		try {
			return new URL(siteUrl.startsWith('sc-domain:') ? `https://${siteUrl.slice(10)}` : siteUrl).origin;
		} catch {
			return null;
		}
	})();
	if (!origin) return null;
	const page = await fetchBytes(origin + '/', origin, { fetchImpl, htmlOnly: true, max: 300_000 });
	const urls: string[] = [];
	if (page.body) urls.push(...iconCandidates(page.body.toString('utf8'), page.finalUrl).map((c) => c.href));
	urls.push(origin + '/favicon.ico');
	for (const url of [...new Set(urls)].slice(0, 5)) {
		// fetchBytes refuses a host that is not the site's own, so a CDN-hosted icon is skipped here by design.
		if (!hostAllowed(url, origin)) continue;
		const r = await fetchBytes(url, origin, { fetchImpl, max: MAX_ICON, accept: 'image/svg+xml,image/png,image/*;q=0.8,*/*;q=0.5' });
		if (!r.body?.length) continue;
		const type = sniffIcon(r.body);
		if (type) return { body: r.body, type };
	}
	return null;
}

/** The cached logo for a site, or null when it has none (or icons are switched off). */
export function siteIcon(siteUrl: string, o: { fetchImpl?: typeof fetch; now?: number } = {}): Promise<SiteIcon | null> {
	if (!config.siteIcons) return Promise.resolve(null);
	const key = siteUrl;
	const now = o.now ?? Date.now();
	const hit = cache.get(key);
	if (hit && now - hit.at < (hit.icon ? HIT_MS : MISS_MS)) return Promise.resolve(hit.icon);
	let p = inflight.get(key);
	if (!p) {
		p = fetchIcon(siteUrl, o.fetchImpl)
			.catch(() => null)
			.then((icon) => {
				cache.set(key, { at: now, icon });
				if (cache.size > 500) cache.delete(cache.keys().next().value!);
				return icon;
			})
			.finally(() => inflight.delete(key));
		inflight.set(key, p);
	}
	return p;
}

export const _clearIconCache = () => cache.clear();
