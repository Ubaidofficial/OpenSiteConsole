import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSite } from '$lib/server/clients';
import { siteIcon } from '$lib/server/siteicon';

/**
 * The site's own logo, fetched server-side (see siteicon.ts). It sits under /sites/[id]/, so the same sign-in, role and per-site
 * access checks as every other site page apply. 204 means "no logo" (not a 404, so the browser console is not filled with errors for every site without one): the avatar keeps its letter.
 */
export const GET: RequestHandler = async ({ params }) => {
	const site = getSite(Number(params.id));
	if (!site) error(404, 'Unknown site');
	const icon = await siteIcon(site.site_url);
	if (!icon) return new Response(null, { status: 204, headers: { 'cache-control': 'private, max-age=600' } });
	return new Response(new Uint8Array(icon.body), {
		headers: {
			'content-type': icon.type,
			'x-content-type-options': 'nosniff',
			// The file is untrusted: opened directly it may not run anything, and in an <img> it never could.
			'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
			'cache-control': 'private, max-age=86400'
		}
	});
};
