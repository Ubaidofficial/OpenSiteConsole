/** Reduce a Search Console property, Bing site, or GA stream URL to a comparable host key. */
export function hostKey(input: string): string {
	let s = input.trim().toLowerCase().replace(/^sc-domain:/, '');
	if (!/^[a-z]+:\/\//.test(s)) s = 'https://' + s;
	try {
		return new URL(s).hostname.replace(/^www\./, '');
	} catch {
		return input.toLowerCase();
	}
}

/** Same site if hosts match, or one is a subdomain of the other (domain property vs. www/blog hosts). */
export function hostsMatch(a: string, b: string): boolean {
	const x = hostKey(a);
	const y = hostKey(b);
	return x === y || x.endsWith('.' + y) || y.endsWith('.' + x);
}

/** Pick the single candidate that matches `target`; exact host beats subdomain; ambiguous → null. */
export function bestMatch<T>(target: string, candidates: T[], urlOf: (c: T) => string): T | null {
	const exact = candidates.filter((c) => hostKey(urlOf(c)) === hostKey(target));
	if (exact.length === 1) return exact[0];
	if (exact.length > 1) return null;
	const loose = candidates.filter((c) => hostsMatch(urlOf(c), target));
	return loose.length === 1 ? loose[0] : null;
}
