import { db } from './db';

/** Verified against Microsoft Learn: Clarity Data Export API. */
export const CLARITY_URL = 'https://www.clarity.ms/export-data/api/v1/project-live-insights';
export const CLARITY_DAILY_LIMIT = 10; // per project per day
/** Calls per scheduled sync: totals, by URL, by device. Leaves headroom for manual refreshes. */
export const CLARITY_SYNC_DIMENSIONS = ['', 'URL', 'Device'] as const;

export class ClarityApiError extends Error {
	constructor(message: string, readonly status: number) {
		super(message);
	}
}

export interface ClarityMetric {
	metricName: string;
	information: Record<string, string | number>[];
}

export const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);

export function callsToday(integrationId: number, day = utcDay()): number {
	const r = db().prepare('SELECT n FROM clarity_calls WHERE integration_id = ? AND day = ?').get(integrationId, day) as { n: number } | undefined;
	return r?.n ?? 0;
}

export function callsLeft(integrationId: number, day = utcDay()): number {
	return Math.max(0, CLARITY_DAILY_LIMIT - callsToday(integrationId, day));
}

/** One live-insights call (counted against the 10/day project quota whether or not it succeeds). */
export async function fetchInsights(
	integrationId: number,
	token: string,
	o: { numOfDays?: 1 | 2 | 3; dimension?: string } = {},
	fetchImpl: typeof fetch = fetch
): Promise<ClarityMetric[]> {
	if (callsLeft(integrationId) <= 0) throw new ClarityApiError('Clarity daily limit (10 requests per project) reached; try again tomorrow (UTC).', 429);
	db()
		.prepare('INSERT INTO clarity_calls (integration_id, day, n) VALUES (?,?,1) ON CONFLICT(integration_id, day) DO UPDATE SET n = n + 1')
		.run(integrationId, utcDay());
	const q = new URLSearchParams({ numOfDays: String(o.numOfDays ?? 1) });
	if (o.dimension) q.set('dimension1', o.dimension);
	let res: Response;
	try {
		res = await fetchImpl(`${CLARITY_URL}?${q}`, { headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } });
	} catch {
		throw new ClarityApiError('Could not reach the Clarity API', 0);
	}
	if (res.ok) return (await res.json()) as ClarityMetric[];
	const msg: Record<number, string> = {
		401: 'Clarity rejected the token (missing, invalid or expired).',
		403: 'This Clarity token is not authorised for the export API.',
		400: 'Clarity rejected the request parameters.',
		429: 'Clarity daily limit reached (10 requests per project per day).'
	};
	throw new ClarityApiError(msg[res.status] ?? `Clarity API ${res.status}`, res.status);
}
