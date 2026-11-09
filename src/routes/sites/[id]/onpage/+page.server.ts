import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { checkUrls, pagesToCheck, storedChecks } from '$lib/server/onpage';
import { getSite } from '$lib/server/clients';
import { brandTerms, pageTotals, periodFor } from '$lib/server/queries';
import { auditFindings, openSeoFor, storedAudit, syncAudit } from '$lib/server/openseolink';
import { openSeoProjectUrl } from '$lib/server/connect';
import { linksFor } from '$lib/server/links';
import { normalizeUrl } from '$lib/analytics';

function openSeoAudit(siteId: number) {
	const os = openSeoFor(siteId);
	if (!os) return null;
	const snap = storedAudit(siteId);
	const site = getSite(siteId)!;
	const clicks = new Map<string, number>();
	try {
		const p = periodFor(site, 28);
		for (const r of pageTotals(siteId, p.start, p.end)) clicks.set(normalizeUrl(r.page), (clicks.get(normalizeUrl(r.page)) ?? 0) + r.clicks);
	} catch {
		/* no data yet */
	}
	const l = linksFor(siteId).openseo;
	return { project: os.projectName, url: l ? openSeoProjectUrl(l.integration_id, l.external_id) : null, snap, findings: snap && !snap.error ? auditFindings(snap, clicks).slice(0, 10) : [] };
}

export const load: PageServerLoad = ({ params }) => {
	const rows = storedChecks(Number(params.id));
	const scored = rows.filter((r) => r.score != null);
	return {
		brandTerms: brandTerms(getSite(Number(params.id))!),
		rows,
		avgScore: scored.length ? Math.round(scored.reduce((a, r) => a + r.score!, 0) / scored.length) : null,
		failed: rows.filter((r) => r.score == null).length,
		openseo: openSeoAudit(Number(params.id))
	};
};

export const actions: Actions = {
	/** Read OpenSEO's latest audit now. Free and read-only: it reads OpenSEO's stored results and runs no audit. */
	oseoAudit: async ({ params }) => {
		const s = await syncAudit(Number(params.id));
		return s?.error ? fail(502, { error: `OpenSEO: ${s.error}` }) : { ok: s?.total ? `Read OpenSEO's latest audit: ${s.total} issues.` : 'OpenSEO has no audit with issues for this project yet.' };
	},
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
