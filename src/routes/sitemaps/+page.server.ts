import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { allSites } from '$lib/server/queries';
import { clientForSite, displayName } from '$lib/server/clients';
import { config } from '$lib/server/config';
import { audit } from '$lib/server/db';
import type { SitemapInfo } from '$lib/server/google';

const eligible = () => allSites().filter((s) => !['siteUnverifiedUser', 'none'].includes(s.permission) && s.account_status === 'active');

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let i = 0;
	await Promise.all(
		Array.from({ length: Math.min(n, items.length) }, async () => {
			while (i < items.length) {
				const k = i++;
				out[k] = await fn(items[k]);
			}
		})
	);
	return out;
}

async function inspectAll() {
	return pool(eligible(), 4, async (s) => {
		try {
			const sm = await clientForSite(s.id).client.listSitemaps(s.site_url);
			return { id: s.id, name: s.label || displayName(s.site_url), sitemaps: sm as SitemapInfo[], error: null as string | null };
		} catch (e) {
			return { id: s.id, name: s.label || displayName(s.site_url), sitemaps: [] as SitemapInfo[], error: e instanceof Error ? e.message : 'failed' };
		}
	});
}

// Returned as a promise so the page shell renders immediately while Google is queried.
export const load: PageServerLoad = () => ({ rows: inspectAll() });

export const actions: Actions = {
	resubmitAll: async () => {
		if (config.readOnly) return fail(403, { error: 'READ_ONLY=1: sitemap changes are disabled.' });
		let ok = 0;
		let failed = 0;
		let skipped = 0;
		await pool(eligible(), 4, async (s) => {
			const { client } = clientForSite(s.id);
			try {
				const known = await client.listSitemaps(s.site_url);
				if (!known.length) return void skipped++;
				for (const sm of known) await client.submitSitemap(s.site_url, sm.path);
				audit('sitemap.resubmit_all', { siteId: s.id, detail: `${known.length} sitemap(s)` });
				ok++;
			} catch {
				failed++;
			}
		});
		return { summary: `Resubmitted sitemaps for ${ok} site(s); ${skipped} had none; ${failed} failed.` };
	}
};
