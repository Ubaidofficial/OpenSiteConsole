import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getKey } from '$lib/server/indexnow';

/** The key file to upload to the site root: its content is exactly the key, and it downloads named <key>.txt. */
export const GET: RequestHandler = ({ params }) => {
	const k = getKey(Number(params.id));
	if (!k) error(404, 'No IndexNow key has been created for this site yet.');
	return new Response(k.key, { headers: { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': `attachment; filename="${k.key}.txt"`, 'cache-control': 'no-store' } });
};
