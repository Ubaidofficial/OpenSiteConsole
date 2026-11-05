import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { config } from '$lib/server/config';
import { db } from '$lib/server/db';
import { allSites } from '$lib/server/queries';
import { displayName } from '$lib/server/clients';
import { listAccounts } from '$lib/server/accounts';
import { allLinks, integrationMeta, linksFor, listIntegrations, removeIntegration, removeLink, setLink, type LinkKind } from '$lib/server/links';
import { autoMatchGa4, connectBingKey, connectClarity, connectCrux, connectOpenSeo, hasGa4Scope } from '$lib/server/connect';
import { callsLeft } from '$lib/server/clarity';
import { enqueueLinkSync } from '$lib/server/jobs';
import { intParam } from '$lib/server/params';
import { env } from '$lib/server/config';

const KINDS: LinkKind[] = ['bing', 'ga4', 'clarity', 'openseo'];
const msg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong');

export const load: PageServerLoad = ({ url }) => {
	const sites = allSites().filter((s) => !['siteUnverifiedUser', 'none'].includes(s.permission));
	const links = allLinks();
	const accounts = listAccounts();
	const bing = listIntegrations('bing').map((i) => ({ id: i.id, label: i.label, auth: integrationMeta(i).auth ?? 'apikey', status: i.status, demo: !!i.is_demo, sites: links.filter((l) => l.kind === 'bing' && l.integration_id === i.id).length }));
	const openseo = listIntegrations('openseo')[0];
	const crux = listIntegrations('crux')[0];
	return {
		crux: crux ? { demo: !!crux.is_demo, sites: (db().prepare('SELECT COUNT(DISTINCT site_id) n FROM crux_daily').get() as { n: number }).n } : null,
		demo: config.demo,
		bingOAuth: !!env('BING_CLIENT_ID') && !!env('BING_CLIENT_SECRET'),
		bingRedirect: `${config.origin}/auth/bing/callback`,
		flash: url.searchParams.get('flash'),
		accounts: accounts.map((a) => ({ id: a.id, email: a.label ?? a.email, status: a.status, ga4: hasGa4Scope(a), demo: !!a.is_demo })),
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
				clarityCallsLeft: clarityInteg ? callsLeft(clarityInteg) : null
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
		const kind = String(f.get('kind')) as 'bing' | 'ga4' | 'clarity';
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
	openseoRemove: async () => {
		for (const i of listIntegrations('openseo')) removeIntegration(i.id);
		db().prepare("DELETE FROM site_links WHERE kind = 'openseo'").run();
		return { ok: 'OpenSEO disconnected.', section: 'openseo' };
	}
};
