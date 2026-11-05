import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { enqueueSiteSync } from '$lib/server/jobs';

export const POST: RequestHandler = ({ params, request }) => {
	enqueueSiteSync(Number(params.id), 'auto');
	redirect(303, request.headers.get('referer') ?? `/sites/${params.id}`);
};
