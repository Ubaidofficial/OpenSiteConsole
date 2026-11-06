import { db } from './db';
import { pacificToday } from './dates';

/**
 * Google's own Search Status Dashboard publishes its incident history as JSON. Ranking updates (core, spam, Discover) are the
 * incidents whose `service_name` is "Ranking"; outages have another service and a SERVICE_DISRUPTION impact. The dashboard
 * keeps only recent history (at the time of writing, back to December 2025), so the app SAVES every update it sees and never
 * deletes one; older ones can be added by hand.
 */
export const GOOGLE_UPDATES_URL = 'https://status.search.google.com/incidents.json';

export type UpdateKind = 'core' | 'spam' | 'discover' | 'other';
export interface GoogleUpdate { id: string; name: string; kind: UpdateKind; begin: string; end: string | null; source: 'google' | 'manual' }

export const kindOf = (name: string): UpdateKind => (/core update/i.test(name) ? (/discover/i.test(name) ? 'discover' : 'core') : /spam update/i.test(name) ? 'spam' : /discover/i.test(name) ? 'discover' : 'other');

/** Read the incident list defensively: anything that is not a Ranking update with a usable date is skipped, never thrown. */
export function parseIncidents(json: unknown): GoogleUpdate[] {
	if (!Array.isArray(json)) return [];
	const out: GoogleUpdate[] = [];
	for (const x of json as Record<string, unknown>[]) {
		if (!x || typeof x !== 'object') continue;
		if (x.service_name !== 'Ranking' || x.status_impact === 'SERVICE_DISRUPTION') continue;
		const name = typeof x.external_desc === 'string' ? x.external_desc.trim().slice(0, 200) : '';
		const begin = typeof x.begin === 'string' ? x.begin.slice(0, 10) : '';
		if (!name || !/^\d{4}-\d{2}-\d{2}$/.test(begin) || typeof x.id !== 'string') continue;
		const end = typeof x.end === 'string' && /^\d{4}-\d{2}-\d{2}/.test(x.end) ? x.end.slice(0, 10) : null;
		out.push({ id: 'g:' + x.id, name, kind: kindOf(name), begin, end, source: 'google' });
	}
	return out;
}

/** Fetch and store. Never throws: returns what happened, so a scheduler tick or a button can report it. */
export async function importGoogleUpdates(fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; added: number; updated: number; total: number; error?: string }> {
	try {
		const res = await fetchImpl(GOOGLE_UPDATES_URL, { signal: AbortSignal.timeout(15_000), headers: { accept: 'application/json' } });
		if (!res.ok) return { ok: false, added: 0, updated: 0, total: 0, error: `Google's status dashboard answered ${res.status}.` };
		const text = await res.text();
		if (text.length > 4_000_000) return { ok: false, added: 0, updated: 0, total: 0, error: 'The feed was unexpectedly large; ignored.' };
		const parsed = parseIncidents(JSON.parse(text));
		const d = db();
		const get = d.prepare('SELECT name, begin_date, end_date FROM google_updates WHERE id = ?');
		const put = d.prepare('INSERT OR REPLACE INTO google_updates (id, name, kind, begin_date, end_date, source, updated_at) VALUES (?,?,?,?,?,?,?)');
		let added = 0, updated = 0;
		d.transaction(() => {
			for (const u of parsed) {
				const had = get.get(u.id) as { name: string; begin_date: string; end_date: string | null } | undefined;
				if (!had) added++;
				else if (had.name !== u.name || had.begin_date !== u.begin || had.end_date !== u.end) updated++;
				put.run(u.id, u.name, u.kind, u.begin, u.end, 'google', Date.now());
			}
		})();
		d.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('google_updates_checked', ?)").run(String(Date.now()));
		return { ok: true, added, updated, total: parsed.length };
	} catch (e) {
		return { ok: false, added: 0, updated: 0, total: 0, error: e instanceof SyntaxError ? "Google's feed was not valid JSON." : 'Could not reach Google\'s status dashboard.' };
	}
}

export const listUpdates = (): GoogleUpdate[] =>
	(db().prepare('SELECT id, name, kind, begin_date begin, end_date end, source FROM google_updates ORDER BY begin_date DESC').all() as GoogleUpdate[]);

export function addManualUpdate(name: string, begin: string, end: string | null) {
	const n = name.trim().slice(0, 200);
	if (!n) throw new Error('Give the update a name.');
	const real = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && new Date(d + 'T00:00:00Z').toISOString().slice(0, 10) === d;
	if (!real(begin)) throw new Error('Enter the start date as a real date (YYYY-MM-DD).');
	if (end && (!real(end) || end < begin)) throw new Error('The end date must be a real date on or after the start.');
	const id = 'm:' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
	db().prepare('INSERT INTO google_updates (id, name, kind, begin_date, end_date, source, updated_at) VALUES (?,?,?,?,?,?,?)').run(id, n, kindOf(n), begin, end, 'manual', Date.now());
	return id;
}

/** Only hand-added updates can be removed; ones from Google would just come back on the next import. */
export const removeManualUpdate = (id: string) => void db().prepare("DELETE FROM google_updates WHERE id = ? AND source = 'manual'").run(id);

/** Updates that overlap [start, end] (an open-ended update is treated as running up to today). */
export function updatesBetween(start: string, end: string): GoogleUpdate[] {
	const today = pacificToday();
	return listUpdates().filter((u) => u.begin <= end && (u.end ?? today) >= start);
}

export const lastUpdatesCheck = () => Number((db().prepare("SELECT value FROM kv WHERE key = 'google_updates_checked'").get() as { value: string } | undefined)?.value ?? 0) || null;

