import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getDigest, listDigests, postWebhook, runUrgentAlerts, runWeeklyDigest, webhook } from '$lib/server/digest';
import { renderText } from '$lib/digest';
import { config } from '$lib/server/config';

export const load: PageServerLoad = ({ url }) => {
	const weekly = listDigests('weekly', 20);
	const wanted = Number(url.searchParams.get('id'));
	const shown = (wanted && getDigest(wanted)?.kind === 'weekly' ? getDigest(wanted) : weekly[0]) ?? null;
	const w = webhook();
	return {
		shown,
		history: weekly.map((d) => ({ id: d.id, createdAt: d.createdAt, weekKey: d.weekKey, delivery: d.delivery })),
		urgent: listDigests('urgent', 15),
		webhook: { configured: !!w.url, format: w.format }
	};
};

export const actions: Actions = {
	generate: async () => {
		const r = await runWeeklyDigest({ force: true });
		return r.created ? { ok: `Digest created${r.delivery === 'sent' ? ' and sent to your webhook' : r.delivery === 'failed' ? `, but sending failed: ${r.message}` : ''}.` } : fail(400, { error: r.message ?? 'Nothing to report yet.' });
	},
	send: async ({ request }) => {
		const id = Number((await request.formData()).get('id'));
		const d = getDigest(id);
		if (!d?.digest) return fail(404, { error: 'That digest no longer exists.' });
		const r = await postWebhook(renderText(d.digest, config.origin), d.digest);
		return r.ok ? { ok: r.message } : fail(502, { error: r.message });
	},
	check: async () => {
		const r = await runUrgentAlerts();
		return { ok: r.alerted ? `${r.alerted} new blocking issue${r.alerted === 1 ? '' : 's'} announced.` : r.delivery === 'failed' ? 'There are new blocking issues but the webhook failed; it will retry.' : 'No new blocking issues.' };
	}
};
