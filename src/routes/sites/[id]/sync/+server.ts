import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { enqueueSiteSync } from '$lib/server/jobs';
import { safeBack } from '$lib/server/guard';

export const POST: RequestHandler = ({ params, request, url }) => {
	enqueueSiteSync(Number(params.id), 'auto');
	redirect(303, safeBack(request.headers.get('referer'), url.origin, `/sites/${params.id}`));
};
