import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getSite } from '$lib/server/clients';
import { audit, db } from '$lib/server/db';
import { createTest, deleteTest, evaluateTestCached, listTests, suggestControlMatched, type TestKind } from '$lib/server/seotests';
import { parseScope } from '$lib/experiments';
import { intParam } from '$lib/server/params';
import { pacificToday } from '$lib/server/dates';
import { enqueueGa4Pages } from '$lib/server/jobs';
import { isAssistant, type TestMetric } from '$lib/server/llmtests';
import { linksFor } from '$lib/server/links';
import { demoAiPlant } from '$lib/server/demo-channels';
import { AI_ASSISTANTS } from '$lib/ai';

export const load: PageServerLoad = async ({ params, parent }) => {
	const { days } = await parent();
	const site = getSite(Number(params.id))!;
	const isDemo = !!(db().prepare('SELECT is_demo FROM accounts WHERE id = ?').get(site.account_id) as { is_demo: number } | undefined)?.is_demo;
	return {
		days,
		today: pacificToday(),
		assistants: [...AI_ASSISTANTS],
		ga4Linked: !!linksFor(site.id).ga4,
		// Demo data has a planted LLM-test result; say where, so it can be tried.
		demoAi: isDemo ? demoAiPlant(site.site_url) : null,
		// One test that cannot be evaluated (corrupt date, say) must not take the whole page, and its Delete button, down.
		tests: listTests(site.id).map((t) => {
			const head = { id: t.id, name: t.name, kind: t.kind, startDate: t.start_date, windowDays: t.window_days, note: t.note, restControl: 'restOfSite' in t.control, fromChangeLog: !!t.meta.annotationId, controlNote: t.meta.controlNote ?? null, controlMethod: t.meta.controlMethod ?? null, metric: t.metric, assistant: t.assistant };
			try {
				return { ...head, error: null as string | null, outcome: evaluateTestCached(site, t) };
			} catch (e) {
				return { ...head, error: e instanceof Error ? e.message : 'This test could not be evaluated.', outcome: null };
			}
		})
	};
};

export const actions: Actions = {
	create: async ({ params, request }) => {
		const f = await request.formData();
		const site = getSite(Number(params.id))!;
		const kind = String(f.get('kind')) as TestKind;
		if (!['before_after', 'split', 'switch'].includes(kind)) return fail(400, { error: 'Choose a test type.' });
		const startDate = String(f.get('startDate') ?? '');
		const windowDays = Number(f.get('windowDays')) || 28;
		const treatment = parseScope(String(f.get('treatment') ?? ''));
		const metric: TestMetric = f.get('metric') === 'ai_sessions' ? 'ai_sessions' : 'clicks';
		const assistantIn = String(f.get('assistant') ?? '');
		if (metric === 'ai_sessions' && assistantIn && !isAssistant(assistantIn)) return fail(400, { error: 'Choose an AI assistant from the list, or all of them.' });
		const assistant = metric === 'ai_sessions' && isAssistant(assistantIn) ? assistantIn : null;
		try {
			const mode = String(f.get('controlMode') ?? 'matched');
			let control = parseScope(String(f.get('control') ?? ''));
			let controlNote: string | undefined;
			let controlMethod: 'sections' | 'traffic' | 'rest' | 'named' | undefined;
			// A switch test's test pages are the old and the new URLs together.
			const scopeForMatch = kind === 'switch' ? parseScope(`${f.get('old') ?? ''} ${f.get('new') ?? ''}`) : treatment;
			if (mode === 'matched') {
				const s = suggestControlMatched(site, scopeForMatch, startDate, windowDays);
				if (s.urls.length) (control = { prefixes: [], urls: s.urls }), (controlNote = s.note), (controlMethod = s.method === 'sections' ? 'sections' : 'traffic');
				else (control = { prefixes: [], urls: [] }), (controlNote = `${s.note} Compared against the rest of the site instead.`), (controlMethod = 'rest');
			} else if (mode === 'named') {
				if (!control.prefixes.length && !control.urls.length) return fail(400, { error: 'Name the control pages, or choose another control option.' });
				controlMethod = 'named';
			} else {
				control = { prefixes: [], urls: [] };
				controlMethod = 'rest';
				controlNote = 'Control = every other page on the site.';
			}
			const id = createTest(site.id, { name: String(f.get('name') ?? ''), kind, startDate, windowDays, treatment, control: control.prefixes.length || control.urls.length ? control : undefined, controlNote, controlMethod, old: parseScope(String(f.get('old') ?? '')), new: parseScope(String(f.get('new') ?? '')), note: String(f.get('note') ?? ''), metric, assistant });
			audit('seo_test.created', { siteId: site.id, detail: `#${id} ${kind}` });
			enqueueGa4Pages(site.id); // conversions for a search test, the daily AI-assistant sessions for an LLM test
			return { ok: 'Test saved. Results firm up as days pass after the change.' };
		} catch (e) {
			return fail(400, { error: e instanceof Error ? e.message : 'Could not save the test.' });
		}
	},
	remove: async ({ params, request }) => {
		deleteTest(Number(params.id), intParam((await request.formData()).get('id')));
		return { ok: 'Test deleted.' };
	}
};
