import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getSite } from '$lib/server/clients';
import { REQUEST_COOLDOWN_DAYS, buildQueue, dismissRequests, markRequested, requestQueue } from '$lib/server/requestindex';

export const load: PageServerLoad = ({ params }) => {
	const site = getSite(Number(params.id))!;
	return { queue: requestQueue(site.id), cooldownDays: REQUEST_COOLDOWN_DAYS };
};

const urlsOf = (f: FormData) => f.getAll('url').map(String).filter(Boolean);

export const actions: Actions = {
	/** Ask Google about the best candidates (URL Inspection, cached 12 h) and keep the ones worth requesting. Spends inspection quota, so it only runs when asked. */
	build: async ({ params }) => {
		const r = await buildQueue(getSite(Number(params.id))!);
		if (r.limitReached) return fail(409, { error: `You have used today's allowance. The next slot frees ${r.nextSlotAt ? new Date(r.nextSlotAt).toLocaleTimeString() : 'within a day'}.` });
		if (!r.candidates) return fail(400, { error: 'No candidates yet: read the sitemaps first (Indexing tab → Read sitemaps now) or submit some URLs.' });
		return { ok: `Asked Google about ${r.asked} page${r.asked === 1 ? '' : 's'}: ${r.listed} worth requesting${r.alreadyIndexed ? `, ${r.alreadyIndexed} already indexed` : ''}${r.problems ? `, ${r.problems} to fix first` : ''}.` };
	},
	/** You pressed Request indexing in Search Console for these: record it, so the re-checks and the results table follow it. */
	requested: async ({ params, request }) => {
		const urls = urlsOf(await request.formData());
		if (!urls.length) return fail(400, { error: 'Nothing selected.' });
		const r = markRequested(getSite(Number(params.id))!, urls, 'app');
		return r.marked ? { ok: `Recorded ${r.marked} request${r.marked === 1 ? '' : 's'}. Google is asked again about each at day 1, 3 and 5.` } : fail(400, { error: 'None of those URLs belong to this site.' });
	},
	dismiss: async ({ params, request }) => {
		const urls = urlsOf(await request.formData());
		const n = dismissRequests(getSite(Number(params.id))!, urls);
		return n ? { ok: `Skipped ${n}. They stay off the list for 30 days.` } : fail(400, { error: 'Nothing selected.' });
	}
};
