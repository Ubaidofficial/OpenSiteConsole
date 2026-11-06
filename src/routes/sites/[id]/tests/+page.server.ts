import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getSite } from '$lib/server/clients';
import { audit } from '$lib/server/db';
import { createTest, deleteTest, evaluateTest, listTests, suggestControl, type TestKind } from '$lib/server/seotests';
import { parseScope } from '$lib/experiments';
import { intParam } from '$lib/server/params';
import { pacificToday } from '$lib/server/dates';

export const load: PageServerLoad = async ({ params, parent }) => {
	const { days } = await parent();
	const site = getSite(Number(params.id))!;
	return {
		days,
		today: pacificToday(),
		// One test that cannot be evaluated (corrupt date, say) must not take the whole page, and its Delete button, down.
		tests: listTests(site.id).map((t) => {
			const head = { id: t.id, name: t.name, kind: t.kind, startDate: t.start_date, windowDays: t.window_days, note: t.note, restControl: 'restOfSite' in t.control };
			try {
				return { ...head, error: null as string | null, outcome: evaluateTest(site, t) };
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
		try {
			let control = parseScope(String(f.get('control') ?? ''));
			if (kind === 'split' && f.get('autoControl') === 'on') {
				const urls = suggestControl(site, treatment, startDate, windowDays);
				if (!urls.length) return fail(400, { error: 'No similar pages with traffic were found outside the test pages. Name the control pages yourself, or leave both empty to compare against the rest of the site.' });
				control = { prefixes: [], urls };
			}
			const id = createTest(site.id, { name: String(f.get('name') ?? ''), kind, startDate, windowDays, treatment, control, old: parseScope(String(f.get('old') ?? '')), new: parseScope(String(f.get('new') ?? '')), note: String(f.get('note') ?? '') });
			audit('seo_test.created', { siteId: site.id, detail: `#${id} ${kind}` });
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
