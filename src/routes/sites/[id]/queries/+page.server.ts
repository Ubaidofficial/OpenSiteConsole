import type { PageServerLoad } from './$types';
import { getSite } from '$lib/server/clients';
import { breakdown, brandTerms, periodFor, topQueries } from '$lib/server/queries';
import { ctrOf, isBranded, pctChange } from '$lib/analytics';
import { isQuestionQuery } from '$lib/trends';
import { POSITION_BUCKETS } from '$lib/plan';

/**
 * A search filter written as a regular expression, like Search Console's own "custom (regex)" filter. Case-insensitive. Patterns are
 * capped at 200 characters; an invalid one is reported back instead of failing the page.
 */
function regexOf(src: string | null): { re: RegExp | null; error: string | null } {
	const s = (src ?? '').trim();
	if (!s) return { re: null, error: null };
	if (s.length > 200) return { re: null, error: 'That pattern is longer than 200 characters.' };
	try {
		return { re: new RegExp(s, 'i'), error: null };
	} catch (e) {
		return { re: null, error: `Not a valid pattern: ${e instanceof Error ? e.message.replace(/^Invalid regular expression: /, '') : 'unknown error'}` };
	}
}

export const load: PageServerLoad = async ({ params, parent, url }) => {
	const { days } = await parent();
	const site = getSite(Number(params.id))!;
	const p = periodFor(site, days);
	const f = { country: url.searchParams.get('country') || undefined, device: url.searchParams.get('device') || undefined };
	const b = url.searchParams.get('b') ?? 'all';
	const onlyQuestions = url.searchParams.get('q') === 'questions';
	const pos = POSITION_BUCKETS.find((x) => x.key === url.searchParams.get('pos')) ?? null;
	const posMin = pos ? (POSITION_BUCKETS[POSITION_BUCKETS.indexOf(pos) - 1]?.max ?? 0) : 0;
	const inc = regexOf(url.searchParams.get('re'));
	const exc = regexOf(url.searchParams.get('nre'));
	const terms = brandTerms(site);
	const prev = new Map(topQueries(site.id, p.prevStart, p.prevEnd, f, 20_000).map((r) => [r.query, r]));
	const rows = topQueries(site.id, p.start, p.end, f, 5000)
		.map((r) => ({
			query: r.query,
			clicks: r.clicks,
			impressions: r.impressions,
			ctr: ctrOf(r),
			position: r.position,
			clicksDelta: pctChange(r.clicks, prev.get(r.query)?.clicks ?? 0),
			posChange: prev.has(r.query) ? r.position - prev.get(r.query)!.position : null,
			branded: isBranded(r.query, terms)
		}))
		.filter((r) => (b === 'brand' ? r.branded : b === 'nonbrand' ? !r.branded : true))
		.filter((r) => (onlyQuestions ? isQuestionQuery(r.query) : true))
		.filter((r) => (pos ? r.position > posMin && r.position <= pos.max : true))
		.filter((r) => (inc.re ? inc.re.test(r.query) : true) && (exc.re ? !exc.re.test(r.query) : true));
	return {
		rows,
		b,
		onlyQuestions,
		pos: pos?.key ?? '',
		re: url.searchParams.get('re') ?? '',
		nre: url.searchParams.get('nre') ?? '',
		regexError: inc.error ?? exc.error,
		filters: f,
		countries: breakdown(site.id, p.start, p.end, 'country').map((c) => c.key),
		devices: breakdown(site.id, p.start, p.end, 'device').map((c) => c.key),
		brandTerms: terms
	};
};
