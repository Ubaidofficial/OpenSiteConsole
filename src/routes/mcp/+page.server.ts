import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/** /mcp is the easy-to-remember address for the MCP page, which lives at /agents (kept so old links and bookmarks still work). */
export const load: PageServerLoad = () => redirect(307, '/agents');
