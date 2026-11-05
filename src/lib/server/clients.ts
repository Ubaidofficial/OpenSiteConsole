import { db } from './db';
import { propertyLabel } from '../property';
import { DemoClient } from './demo';
import { RealClient, type GscClient } from './google';

const demoClients = new Map<string, DemoClient>();

export interface AccountLite {
	id: number;
	google_sub: string;
	is_demo: number;
}

export function clientForAccount(a: AccountLite): GscClient {
	if (a.is_demo) {
		let c = demoClients.get(a.google_sub);
		if (!c) demoClients.set(a.google_sub, (c = new DemoClient(a.google_sub)));
		return c;
	}
	return new RealClient(a.id);
}

export interface SiteRow {
	id: number;
	account_id: number;
	site_url: string;
	permission: string;
	hidden: number;
	label: string | null;
	tags: string;
	brand_terms: string;
	synced_through: string | null;
	backfilled_to: string | null;
	backfill_done: number;
	last_sync_at: number | null;
	sync_status: string;
	sync_message: string | null;
	types_synced_at: number | null;
	appearance_pulled_on: string | null;
	created_at: number;
}

export function getSite(id: number): SiteRow | undefined {
	return db().prepare('SELECT * FROM sites WHERE id = ?').get(id) as SiteRow | undefined;
}

export function clientForSite(siteId: number): { client: GscClient; site: SiteRow } {
	const site = getSite(siteId);
	if (!site) throw new Error(`Unknown site ${siteId}`);
	const acc = db().prepare('SELECT id, google_sub, is_demo FROM accounts WHERE id = ?').get(site.account_id) as AccountLite;
	return { client: clientForAccount(acc), site };
}

/** Display name: domain properties lose the sc-domain: prefix, URL-prefix properties lose the scheme. */
export function displayName(siteUrl: string): string {
	return propertyLabel(siteUrl);
}
