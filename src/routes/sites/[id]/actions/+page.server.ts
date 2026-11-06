import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getSite } from '$lib/server/clients';
import { queueFor, setActionState } from '$lib/server/actions';
import { scoreOf } from '$lib/actions';

export const load: PageServerLoad = ({ params }) => {
	const site = getSite(Number(params.id))!;
	const q = queueFor(site);
	return {
		open: q.open.map((a) => ({ ...a, score: Math.round(scoreOf(a)) })),
		hidden: q.hidden
	};
};

export const actions: Actions = {
	state: async ({ params, request }) => {
		const f = await request.formData();
		const state = String(f.get('state'));
		const key = String(f.get('key') ?? '');
		if (!key || !['done', 'snoozed', 'open'].includes(state)) return fail(400, { error: 'Unknown action.' });
		setActionState(Number(params.id), key, state as 'done' | 'snoozed' | 'open');
		return { ok: state === 'done' ? 'Marked done: hidden for 90 days, and it returns if the problem is still there.' : state === 'snoozed' ? 'Snoozed for 30 days.' : 'Restored to the queue.' };
	}
};
