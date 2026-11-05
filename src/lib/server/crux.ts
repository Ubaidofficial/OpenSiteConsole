import { db } from './db';
import { integrationSecret, listIntegrations } from './links';
import { getSite } from './clients';
import { pacificToday } from './dates';
import { demoCruxFetch } from './demo-channels';
import type { VitalKey } from '../vitals';

/**
 * Chrome UX Report (CrUX) API: real-user field data for an origin, 28-day rolling, p75. Needs a free Google Cloud API key.
 * An origin with too little traffic has no record (HTTP 404), which is normal and not an error.
 */
const ENDPOINT = 'https://chromeuxreport.googleapis.com/v1/records:queryRecord';
export type FormFactor = 'PHONE' | 'DESKTOP';
export const FORM_FACTORS: FormFactor[] = ['PHONE', 'DESKTOP'];

export class CruxError extends Error {
	constructor(message: string, readonly status: number) {
		super(message);
	}
}

export interface CruxResult {
	origin: string;
	values: Record<VitalKey, number | null>;
	/** Share of page loads rated "good" for the three Core Web Vitals (first histogram bin). */
	goodShare: Partial<Record<'lcp' | 'inp' | 'cls', number>>;
}

// CrUX metric names -> our keys. Names are Google's; any metric the API does not return is simply null.
const METRIC: Record<VitalKey, string> = {
	lcp: 'largest_contentful_paint',
	inp: 'interaction_to_next_paint',
	cls: 'cumulative_layout_shift',
	fcp: 'first_contentful_paint',
	ttfb: 'experimental_time_to_first_byte'
};

interface RawMetric { percentiles?: { p75?: number | string }; histogram?: { density?: number | string }[] }

export function parseRecord(origin: string, json: { record?: { metrics?: Record<string, RawMetric> } }): CruxResult {
	const m = json.record?.metrics ?? {};
	const num = (v: unknown) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
	const values = Object.fromEntries((Object.keys(METRIC) as VitalKey[]).map((k) => [k, num(m[METRIC[k]]?.percentiles?.p75)])) as Record<VitalKey, number | null>;
	const goodShare: CruxResult['goodShare'] = {};
	for (const k of ['lcp', 'inp', 'cls'] as const) {
		const d = num(m[METRIC[k]]?.histogram?.[0]?.density);
		if (d != null) goodShare[k] = d;
	}
	return { origin, values, goodShare };
}

/** `null` when CrUX has no data for the origin (not enough traffic). Throws CruxError for key/quota/other failures. */
export async function queryOrigin(apiKey: string, origin: string, formFactor: FormFactor, fetchImpl: typeof fetch = fetch): Promise<CruxResult | null> {
	const res = await fetchImpl(`${ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ origin, formFactor })
	});
	if (res.status === 404) return null;
	const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } } & { record?: never };
	if (!res.ok) throw new CruxError(body.error?.message ?? `Chrome UX Report API returned ${res.status}`, res.status);
	return parseRecord(origin, body as never);
}

/**
 * Origins to try for a Search Console property. A URL-prefix property names its origin. A Domain property does not say
 * whether the site lives on the bare domain or www, so both are tried, bare first.
 */
export function originCandidates(siteUrl: string): string[] {
	if (siteUrl.startsWith('sc-domain:')) {
		const host = siteUrl.slice('sc-domain:'.length);
		return [`https://${host}`, `https://www.${host}`];
	}
	try {
		return [new URL(siteUrl).origin];
	} catch {
		return [];
	}
}

export const cruxIntegration = () => listIntegrations('crux').find((i) => i.status === 'active');

export async function syncCrux(siteId: number, o: { fetchImpl?: typeof fetch; today?: string } = {}): Promise<{ stored: number }> {
	const integ = cruxIntegration();
	if (!integ) throw new Error('Core Web Vitals (Chrome UX Report) is not connected');
	const site = getSite(siteId);
	if (!site) throw new Error('Unknown site');
	const key = integrationSecret<{ apiKey: string }>(integ).apiKey;
	const fetchImpl = o.fetchImpl ?? (integ.is_demo ? demoCruxFetch() : fetch);
	const today = o.today ?? pacificToday();
	const d = db();
	const ins = d.prepare('INSERT OR REPLACE INTO crux_daily (site_id, date, form_factor, origin, lcp, inp, cls, fcp, ttfb, lcp_good, inp_good, cls_good) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
	let stored = 0;
	let error: CruxError | null = null;
	for (const ff of FORM_FACTORS) {
		for (const origin of originCandidates(site.site_url)) {
			try {
				const r = await queryOrigin(key, origin, ff, fetchImpl);
				if (!r) continue;
				ins.run(siteId, today, ff, r.origin, r.values.lcp, r.values.inp, r.values.cls, r.values.fcp, r.values.ttfb, r.goodShare.lcp ?? null, r.goodShare.inp ?? null, r.goodShare.cls ?? null);
				stored++;
				break; // the first origin with data wins
			} catch (e) {
				error = e instanceof CruxError ? e : new CruxError(e instanceof Error ? e.message : String(e), 0);
				if (error.status === 400 || error.status === 401 || error.status === 403) throw error; // key problem: no point trying more
			}
		}
	}
	d.prepare('UPDATE sites SET crux_pulled_on = ? WHERE id = ?').run(today, siteId);
	if (!stored && error) throw error;
	return { stored };
}

/** Latest snapshot per form factor, plus the daily history we have collected. */
export function cruxLatest(siteId: number) {
	const rows = db().prepare('SELECT * FROM crux_daily WHERE site_id = ? ORDER BY date DESC').all(siteId) as CruxRow[];
	const latest = new Map<FormFactor, CruxRow>();
	for (const r of rows) if (!latest.has(r.form_factor)) latest.set(r.form_factor, r);
	return { latest, history: rows.slice().reverse() };
}

export interface CruxRow {
	site_id: number; date: string; form_factor: FormFactor; origin: string;
	lcp: number | null; inp: number | null; cls: number | null; fcp: number | null; ttfb: number | null;
	lcp_good: number | null; inp_good: number | null; cls_good: number | null;
}

