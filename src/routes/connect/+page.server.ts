import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { config } from '$lib/server/config';
import { db } from '$lib/server/db';
import { allSites } from '$lib/server/queries';
import { displayName } from '$lib/server/clients';
import { listAccounts } from '$lib/server/accounts';
import { allLinks, integrationMeta, linksFor, listIntegrations, removeIntegration, removeLink, setLink, type LinkKind } from '$lib/server/links';
import { autoMatchGa4, autoMatchGtm, connectBingKey, connectClarity, connectCrux, connectOpenSeo, hasGa4Scope, hasGtmScope, linkGtmManually } from '$lib/server/connect';
import { callsLeft } from '$lib/server/clarity';
import { enqueueLinkSync } from '$lib/server/jobs';
import { gtmSnapshot } from '$lib/server/tracking';
import { GA4_TAG_TYPES } from '$lib/server/gtm';
import { checkClarityNow } from '$lib/server/clarityscan';
import { gtmOnSite, planSetup, runSetup, startGa4Account, type SetupChoices } from '$lib/server/setup';
import { intParam } from '$lib/server/params';
import { env } from '$lib/server/config';

const KINDS: LinkKind[] = ['bing', 'ga4', 'gtm', 'clarity', 'openseo'];
const msg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong');

/** The decisions made on the setup panel, from its form. Empty fields are left out so the plan's own defaults apply. */
function choicesFrom(f: { get(name: string): unknown }): SetupChoices {
	const v = (k: string) => String(f.get(k) ?? '').trim() || undefined;
	return { ga4Property: v('ga4Property'), ga4Account: v('ga4Account'), gtmContainer: v('gtmContainer'), gtmAccount: v('gtmAccount'), timeZone: v('timeZone'), currencyCode: v('currencyCode')?.toUpperCase() };
}

export const load: PageServerLoad = async ({ url }) => {
	const sites = allSites().filter((s) => !['siteUnverifiedUser', 'none'].includes(s.permission));
	const links = allLinks();
	const accounts = listAccounts();
	const bing = listIntegrations('bing').map((i) => ({ id: i.id, label: i.label, auth: integrationMeta(i).auth ?? 'apikey', status: i.status, demo: !!i.is_demo, sites: links.filter((l) => l.kind === 'bing' && l.integration_id === i.id).length }));
	const openseo = listIntegrations('openseo')[0];
	const crux = listIntegrations('crux')[0];
	// The setup panel: opened from a site's "Set up GA4 & Tag Manager" button (?setup=ID). Reading the plan only ever reads.
	const choices = choicesFrom(url.searchParams);
	const setupId = Number(url.searchParams.get('setup'));
	const setupSite = sites.find((s) => s.id === setupId);
	const setup = setupSite
		? await planSetup(setupSite.id, choices).catch((e) => ({ ok: false as const, error: msg(e), blockers: [] as string[], ready: false }))
		: null;
	const setupContainer = setup && 'gtm' in setup && setup.gtm && (setup.gtm.state === 'linked' || setup.gtm.state === 'match') ? setup.gtm.publicId : (setupSite ? linksFor(setupSite.id).gtm?.label?.split(' · ')[0] ?? null : null);
	return {
		setupSite: setupSite ? { id: setupSite.id, name: displayName(setupSite.site_url) } : null,
		setup,
		choices,
		setupOnSite: setupSite && setupContainer ? gtmOnSite(setupSite.id, setupContainer) : null,
		readOnly: config.readOnly,
		crux: crux ? { demo: !!crux.is_demo, sites: (db().prepare('SELECT COUNT(DISTINCT site_id) n FROM crux_daily').get() as { n: number }).n } : null,
		demo: config.demo,
		bingOAuth: !!env('BING_CLIENT_ID') && !!env('BING_CLIENT_SECRET'),
		bingRedirect: `${config.origin}/auth/bing/callback`,
		flash: url.searchParams.get('flash'),
		accounts: accounts.map((a) => ({ id: a.id, email: a.label ?? a.email, status: a.status, ga4: hasGa4Scope(a), gtm: hasGtmScope(a), demo: !!a.is_demo })),
		bing,
		openseo: openseo ? { baseUrl: integrationMeta(openseo).baseUrl, demo: !!openseo.is_demo, linked: links.filter((l) => l.kind === 'openseo').length } : null,
		progress: Object.fromEntries(KINDS.map((k) => [k, links.filter((l) => l.kind === k).length])) as Record<LinkKind, number>,
		total: sites.length,
		rows: sites.map((s) => {
			const l = linksFor(s.id);
			const clarityInteg = l.clarity?.integration_id ?? null;
			return {
				id: s.id,
				name: displayName(s.site_url),
				account: s.account_label ?? s.account_email,
				google: s.synced_through ? 'synced' : s.sync_status,
				links: Object.fromEntries(KINDS.map((k) => [k, l[k] ? { id: l[k]!.external_id, label: l[k]!.label, status: l[k]!.sync_status, message: l[k]!.sync_message, lastSync: l[k]!.last_sync_at } : null])) as Record<LinkKind, { id: string; label: string | null; status: string; message: string | null; lastSync: number | null } | null>,
				clarityCallsLeft: clarityInteg ? callsLeft(clarityInteg) : null,
				// the "Set up GA4 & Tag Manager" button: nothing linked yet, or a container whose live version has no Google tag
				needsSetup: !l.ga4 || !l.gtm || (() => { const g = gtmSnapshot(s.id); return !g?.published || !g.tags.some((t) => GA4_TAG_TYPES.has(t.type)); })()
			};
		})
	};
};

export const actions: Actions = {
	bingKey: async ({ request }) => {
		const f = await request.formData();
		try {
			const r = await connectBingKey(String(f.get('apiKey') ?? ''), String(f.get('label') ?? ''));
			return { ok: `Bing connected. Linked ${r.matched} of your sites automatically (${r.bingSites} Bing site(s) found).${r.unmatchedBing.length ? ` Not matched: ${r.unmatchedBing.join(', ')}.` : ''}${r.unverified.length ? ` Unverified in Bing (no data until verified): ${r.unverified.join(', ')}.` : ''}`, section: 'bing' };
		} catch (e) {
			return fail(400, { error: msg(e), section: 'bing' });
		}
	},
	bingRemove: async ({ request }) => {
		removeIntegration(intParam((await request.formData()).get('id')));
		return { ok: 'Bing connection removed.', section: 'bing' };
	},
	ga4Auto: async () => {
		try {
			const r = await autoMatchGa4();
			const parts = [`Linked ${r.matched} site(s) to GA4 properties.`];
			if (r.ambiguous.length) parts.push(`Several properties matched: ${r.ambiguous.join(', ')} — link those by hand.`);
			if (r.unmatchedSites.length) parts.push(`No property found for: ${r.unmatchedSites.join(', ')}.`);
			if (r.noScope.length) parts.push(`Reconnect ${r.noScope.join(', ')} to grant GA4 access.`);
			return { ok: parts.join(' '), section: 'ga4' };
		} catch (e) {
			return fail(502, { error: msg(e), section: 'ga4' });
		}
	},
	gtmAuto: async () => {
		try {
			const r = await autoMatchGtm();
			const parts = [`Linked ${r.matched} site(s) to Tag Manager containers.`];
			if (r.ambiguous.length) parts.push(`Several containers matched: ${r.ambiguous.join(', ')} — link those by hand.`);
			if (r.unmatchedSites.length) parts.push(`No container found for: ${r.unmatchedSites.join(', ')}. (Containers are matched by their domain or by a name that is the site's address.)`);
			if (r.noScope.length) parts.push(`Reconnect ${r.noScope.join(', ')} to grant Tag Manager access.`);
			return { ok: parts.join(' '), section: 'gtm' };
		} catch (e) {
			return fail(502, { error: msg(e), section: 'gtm' });
		}
	},
	clarity: async ({ request }) => {
		const f = await request.formData();
		const siteId = intParam(f.get('siteId'));
		try {
			await connectClarity(siteId, String(f.get('token') ?? ''));
			enqueueLinkSync(siteId, 'clarity');
			return { ok: 'Clarity connected. The first snapshot is already stored.', section: 'clarity' };
		} catch (e) {
			return fail(400, { error: msg(e), section: 'clarity', siteId });
		}
	},
	manual: async ({ request }) => {
		const f = await request.formData();
		const siteId = intParam(f.get('siteId'));
		const kind = String(f.get('kind'));
		const ext = String(f.get('externalId') ?? '').trim();
		if (!ext) return fail(400, { error: 'Enter a value to link.', section: kind });
		if (kind === 'gtm') {
			try {
				const c = await linkGtmManually(siteId, ext);
				return { ok: `Linked to ${c.publicId} (${c.name}). Syncing in the background.`, section: 'gtm' };
			} catch (e) {
				return fail(400, { error: msg(e), section: 'gtm' });
			}
		}
		if (kind === 'ga4') {
			if (!/^properties\/\d+$/.test(ext)) return fail(400, { error: 'GA4 property must look like properties/123456789.', section: 'ga4' });
			const site = allSites().find((s) => s.id === siteId);
			if (!site) return fail(404, { error: 'Unknown site', section: 'ga4' });
			setLink(siteId, 'ga4', { accountId: site.account_id, externalId: ext, label: ext });
			enqueueLinkSync(siteId, 'ga4');
		} else if (kind === 'bing') {
			const integ = listIntegrations('bing')[0];
			if (!integ) return fail(400, { error: 'Connect Bing first.', section: 'bing' });
			setLink(siteId, 'bing', { integrationId: integ.id, externalId: ext, label: ext });
			enqueueLinkSync(siteId, 'bing');
		} else return fail(400, { error: 'Unsupported link type', section: kind });
		return { ok: 'Linked. Syncing in the background.', section: kind };
	},
	unlink: async ({ request }) => {
		const f = await request.formData();
		removeLink(intParam(f.get('siteId')), String(f.get('kind')) as LinkKind);
		return { ok: 'Unlinked.' };
	},
	resync: async ({ request }) => {
		const f = await request.formData();
		const kind = String(f.get('kind')) as 'bing' | 'ga4' | 'gtm' | 'clarity';
		enqueueLinkSync(intParam(f.get('siteId')), kind);
		return { ok: 'Sync queued.' };
	},
	openseo: async ({ request }) => {
		const f = await request.formData();
		try {
			const r = await connectOpenSeo(String(f.get('baseUrl') ?? ''), String(f.get('apiKey') ?? ''));
			return { ok: `OpenSEO connected. Linked ${r.matched} site(s) to projects (${r.projects} project(s) found).${r.unmatchedProjects.length ? ` No matching site for: ${r.unmatchedProjects.join(', ')}.` : ''}`, section: 'openseo' };
		} catch (e) {
			return fail(400, { error: msg(e), section: 'openseo' });
		}
	},
	crux: async ({ request }) => {
		try {
			const r = await connectCrux(String((await request.formData()).get('apiKey') ?? ''));
			return { ok: `Chrome UX Report connected. Fetching Core Web Vitals for ${r.sites} site(s); sites with too little Chrome traffic simply have none.`, section: 'crux' };
		} catch (e) {
			return fail(400, { error: msg(e), section: 'crux' });
		}
	},
	cruxRemove: async () => {
		for (const i of listIntegrations('crux')) removeIntegration(i.id);
		return { ok: 'Chrome UX Report disconnected. Stored snapshots are kept.', section: 'crux' };
	},
	/** The confirmed setup: find or create the GA4 property and container, link both, add the Google tag. The button says whether to publish it. */
	setupRun: async ({ request, url }) => {
		const f = await request.formData();
		const siteId = intParam(f.get('siteId'));
		const mode = f.get('mode') === 'publish' ? 'publish' : 'workspace';
		const result = await runSetup(siteId, choicesFrom(f), mode).catch((e) => ({ ok: false as const, error: msg(e), steps: [], published: false }));
		return result.ok ? { section: 'setup', setupResult: result } : fail(400, { section: 'setup', setupResult: result });
	},
	/** For someone with no Google Analytics account: get Google's Terms of Service link. */
	setupTos: async ({ request }) => {
		const f = await request.formData();
		const siteId = intParam(f.get('siteId'));
		const r = await startGa4Account(siteId, { regionCode: String(f.get('regionCode') ?? '') }).catch((e) => ({ ok: false as const, error: msg(e), url: undefined }));
		return r.ok ? { section: 'setup', tosUrl: r.url } : fail(400, { section: 'setup', setupError: r.error });
	},
	/** Look at the site's pages now: do they load the container? */
	setupCheck: async ({ request }) => {
		const siteId = intParam((await request.formData()).get('siteId'));
		await checkClarityNow(siteId).catch(() => {});
		return { section: 'setup', checked: true };
	},
	openseoRemove: async () => {
		for (const i of listIntegrations('openseo')) removeIntegration(i.id);
		db().prepare("DELETE FROM site_links WHERE kind = 'openseo'").run();
		return { ok: 'OpenSEO disconnected.', section: 'openseo' };
	}
};
