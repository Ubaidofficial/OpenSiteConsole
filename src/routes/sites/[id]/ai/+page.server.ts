import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getSite } from '$lib/server/clients';
import { config } from '$lib/server/config';
import { audit } from '$lib/server/db';
import { addPrompts, aiVisReport, budgetLeft, deletePrompt, setCompetitors } from '$lib/server/aivis';
import { KEY_ENV_NAMES, engineModel } from '$lib/server/aiengines';
import { aiVisRunning, enqueueAiVis } from '$lib/server/jobs';
import { AI_ENGINES } from '$lib/aivis';

export const load: PageServerLoad = async ({ params }) => {
	const site = getSite(Number(params.id))!;
	return {
		report: aiVisReport(site),
		running: aiVisRunning(site.id),
		setup: AI_ENGINES.map((e) => ({ engine: e, keyEnv: KEY_ENV_NAMES[e], model: engineModel(e) }))
	};
};

export const actions: Actions = {
	addPrompts: async ({ params, request }) => {
		const text = String((await request.formData()).get('prompts') ?? '');
		if (text.length > 30_000) return fail(400, { error: 'Too much text at once.' });
		const r = addPrompts(Number(params.id), text);
		if (r.added) audit('aivis.prompts', { siteId: Number(params.id), detail: `+${r.added}` });
		return r.added ? { ok: `Added ${r.added} prompt${r.added === 1 ? '' : 's'}.${r.skipped.length ? ` Skipped: ${r.skipped.join('; ')}.` : ''}` } : fail(400, { error: r.skipped.length ? `Nothing added: ${r.skipped.join('; ')}.` : 'Type one prompt per line.' });
	},
	deletePrompt: async ({ params, request }) => {
		const id = Number((await request.formData()).get('id'));
		return deletePrompt(Number(params.id), id) ? { ok: 'Prompt and its answers removed.' } : fail(404, { error: 'No such prompt.' });
	},
	competitors: async ({ params, request }) => {
		const list = setCompetitors(getSite(Number(params.id))!, String((await request.formData()).get('competitors') ?? '').slice(0, 5000));
		return { ok: list.length ? `Comparing with ${list.join(', ')}. Older answers keep the competitors they were judged with.` : 'No competitors.' };
	},
	/** Ask every prompt again now (those not asked in the last hour), in the background, within today's cap. It spends money on the API accounts. */
	run: async ({ params }) => {
		if (config.readOnly) return fail(403, { error: 'READ_ONLY=1: AI visibility runs are disabled (they spend money on your API accounts).' });
		const site = getSite(Number(params.id))!;
		if (!budgetLeft()) return fail(429, { error: 'Today\'s cap on AI runs is used up (AI_VIS_RUNS_PER_DAY). It resets at midnight UTC.' });
		enqueueAiVis(site.id);
		return { ok: 'Asking the assistants now. Answers appear as they arrive; each can take up to a minute.' };
	}
};
