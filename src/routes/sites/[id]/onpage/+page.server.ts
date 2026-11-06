import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { checkUrls, pagesToCheck, storedChecks } from '$lib/server/onpage';
import { getSite } from '$lib/server/clients';
import { brandTerms } from '$lib/server/queries';

export const load: PageServerLoad = ({ params }) => {
	const rows = storedChecks(Number(params.id));
	const scored = rows.filter((r) => r.score != null);
	return {
		brandTerms: brandTerms(getSite(Number(params.id))!),
		rows,
		avgScore: scored.length ? Math.round(scored.reduce((a, r) => a + r.score!, 0) / scored.length) : null,
		failed: rows.filter((r) => r.score == null).length
	};
};

export const actions: Actions = {
	top: async ({ params }) => {
		const id = Number(params.id);
		const urls = pagesToCheck(id, 15);
		if (!urls.length) return fail(400, { error: 'No page data yet.' });
		const r = await checkUrls(id, urls);
		return { ok: `Checked ${r.ok} page(s)${r.failed ? `; ${r.failed} could not be fetched` : ''}.` };
	},
	urls: async ({ params, request }) => {
		const urls = String((await request.formData()).get('urls') ?? '').split(/\s+/).filter((u) => /^https?:\/\/\S+$/.test(u));
		if (!urls.length) return fail(400, { error: 'Paste one or more full URLs from this site (up to 25).' });
		const r = await checkUrls(Number(params.id), urls);
		return { ok: `Checked ${r.ok} page(s)${r.failed ? `; ${r.failed} could not be fetched` : ''}.`, truncated: urls.length > 25 };
	}
};
