import { db, audit } from './db';
import { env, config } from './config';
import { displayName, type SiteRow } from './clients';
import { addDays, pacificToday } from './dates';
import { allSites, periodFor, summary, topPages, topQueries } from './queries';
import { computeMovers, type Keyed } from '../trends';
import { pctChange } from '../analytics';
import { rankActions } from '../actions';
import { URGENT_SHOWN, clicksSignificant, headlineOf, renderText, renderUrgent, type Digest, type SiteDigest } from '../digest';
import { comparability } from './insights';
import { queueFor } from './actions';
import { recentEvents } from './indexmon';
import { updatesBetween } from './gupdates';
import { evaluateTestCached, listTests, mainResult } from './seotests';

const visibleSites = () => allSites().filter((s) => !['siteUnverifiedUser', 'none'].includes(s.permission));
const keyed = (rows: { query?: string; page?: string; clicks: number; impressions: number; position: number }[]): Keyed[] => rows.map((r) => ({ key: (r.query ?? r.page)!, clicks: r.clicks, impressions: r.impressions, position: r.position }));
const lite = (xs: { key: string; change: number }[]) => xs.slice(0, 3).map((m) => ({ key: m.key, change: m.change }));

/** One site's week: the last 7 days against the 7 before, what changed, and its top actions. */
export function buildSiteDigest(site: SiteRow): SiteDigest {
	const p = periodFor(site, 7);
	const cmp = comparability(site, p);
	const now = summary(site.id, p.start, p.end);
	const prev = cmp.comparable ? summary(site.id, p.prevStart, p.prevEnd) : { clicks: 0, impressions: 0, position: 0 };
	let qm = { winners: [] as { key: string; change: number }[], losers: [] as { key: string; change: number }[] };
	let pm = qm;
	if (cmp.comparable) {
		qm = computeMovers(keyed(topQueries(site.id, p.start, p.end, {}, 50_000)), keyed(topQueries(site.id, p.prevStart, p.prevEnd, {}, 50_000)), { minChange: 5, limit: 3 });
		pm = computeMovers(keyed(topPages(site.id, p.start, p.end, {}, 20_000)), keyed(topPages(site.id, p.prevStart, p.prevEnd, {}, 20_000)), { minChange: 5, limit: 3 });
	}
	const since = Date.now() - 7 * 86_400_000;
	const decidedTests: SiteDigest['decidedTests'] = [];
	for (const t of listTests(site.id)) {
		try {
			const o = evaluateTestCached(site, t);
			const r = mainResult(o);
			if ((r.verdict === 'positive' || r.verdict === 'negative') && o.postDays >= 21) decidedTests.push({ name: t.name, verdict: r.verdict, lift: r.lift });
		} catch {
			/* shown on the Tests tab */
		}
	}
	const q = queueFor(site);
	return {
		siteId: site.id,
		name: displayName(site.site_url),
		week: { start: p.start, end: p.end },
		comparable: cmp.comparable,
		clicks: { now: now.clicks, prev: prev.clicks, change: cmp.comparable ? pctChange(now.clicks, prev.clicks) : null, significant: cmp.comparable && clicksSignificant(now.clicks, prev.clicks) },
		impressions: { now: now.impressions, prev: prev.impressions, change: cmp.comparable ? pctChange(now.impressions, prev.impressions) : null },
		position: { now: now.position, prev: prev.position },
		queryWinners: lite(qm.winners), queryLosers: lite(qm.losers), pageWinners: lite(pm.winners), pageLosers: lite(pm.losers),
		droppedPages: recentEvents(site.id, 200).filter((e) => e.at >= since && e.kind === 'deindexed').length,
		events: recentEvents(site.id, 200).filter((e) => e.at >= since).slice(0, 10).map((e) => ({ kind: e.kind, url: e.url, detail: e.detail })),
		updates: updatesBetween(p.start, p.end).map((u) => ({ name: u.name, kind: u.kind, begin: u.begin, end: u.end, startedThisWeek: u.begin >= p.start && u.begin <= p.end, endedThisWeek: !!u.end && u.end >= p.start && u.end <= p.end })),
		decidedTests: decidedTests.slice(0, 3),
		openActions: q.open.length,
		blockingActions: q.open.filter((a) => a.blocking).length,
		topActions: q.open.slice(0, 5).map((a) => ({ key: a.key, type: a.type, title: a.title, blocking: a.blocking, impact: a.impact, confidence: a.confidence, href: a.href }))
	};
}

/** The digest for a set of sites (all visible ones by default). */
export function buildDigest(sites: SiteRow[] = visibleSites(), now = Date.now()): Digest {
	const digests = sites.map((s) => {
		try {
			return buildSiteDigest(s);
		} catch {
			return null; // one broken site must not hide the others
		}
	}).filter((x): x is SiteDigest => !!x);
	const top = rankActions(
		digests.flatMap((s) => {
			const site = sites.find((x) => x.id === s.siteId)!;
			return queueFor(site).open.map((a) => ({ ...a, site: s.name }));
		})
	).slice(0, 10).map((a) => ({ key: a.key, type: a.type, title: a.title, blocking: a.blocking, impact: a.impact, confidence: a.confidence, href: a.href, site: a.site, siteId: a.siteId }));
	const weekEnd = digests.map((d) => d.week.end).sort().at(-1) ?? pacificToday();
	return { createdAt: now, weekEnd, headline: headlineOf(digests, top), sites: digests, top };
}

// ── delivery ─────────────────────────────────────────────────────────────────
export type WebhookFormat = 'slack' | 'discord' | 'json';
export const webhook = () => {
	const url = env('DIGEST_WEBHOOK_URL').trim();
	const f = env('DIGEST_WEBHOOK_FORMAT', 'slack').toLowerCase();
	return { url: url || null, format: (['slack', 'discord', 'json'].includes(f) ? f : 'slack') as WebhookFormat };
};

/**
 * POST to the operator's webhook (set in .env, never taken from a form, so this app cannot be pointed at an arbitrary address by
 * someone using the UI). https only, except for localhost; no redirects; 10 s; the reply body is not kept.
 */
export async function postWebhook(text: string, digest: unknown, fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; message: string }> {
	const w = webhook();
	if (!w.url) return { ok: false, message: 'No webhook is configured (DIGEST_WEBHOOK_URL).' };
	let u: URL;
	try {
		u = new URL(w.url);
	} catch {
		return { ok: false, message: 'DIGEST_WEBHOOK_URL is not a valid URL.' };
	}
	if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname))) return { ok: false, message: 'DIGEST_WEBHOOK_URL must be https.' };
	const body = w.format === 'discord' ? { content: text.slice(0, 1900), allowed_mentions: { parse: [] as string[] } } : w.format === 'json' ? { text, digest } : { text };
	try {
		const res = await fetchImpl(u, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
		void res.body?.cancel().catch(() => {});
		return res.ok ? { ok: true, message: `Delivered (HTTP ${res.status}).` } : { ok: false, message: `The webhook answered HTTP ${res.status}.` };
	} catch (e) {
		return { ok: false, message: e instanceof Error && e.name === 'TimeoutError' ? 'The webhook did not answer within 10 seconds.' : 'Could not reach the webhook.' };
	}
}

export interface StoredDigest { id: number; kind: string; weekKey: string | null; createdAt: number; delivery: string; deliveredAt: number | null; message: string | null; digest: Digest | null; urgent: { items: { site: string; title: string; why: string; href: string }[] } | null }
const hydrate = (r: { id: number; kind: string; week_key: string | null; created_at: number; payload: string; delivery: string; delivered_at: number | null; delivery_message: string | null }): StoredDigest => {
	const payload = JSON.parse(r.payload);
	return { id: r.id, kind: r.kind, weekKey: r.week_key, createdAt: r.created_at, delivery: r.delivery, deliveredAt: r.delivered_at, message: r.delivery_message, digest: r.kind === 'weekly' ? payload : null, urgent: r.kind === 'urgent' ? payload : null };
};
export const listDigests = (kind: 'weekly' | 'urgent', limit = 30) => (db().prepare('SELECT * FROM digests WHERE kind = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(kind, limit) as never[]).map(hydrate);
export const getDigest = (id: number) => { const r = db().prepare('SELECT * FROM digests WHERE id = ?').get(id); return r ? hydrate(r as never) : null; };

const record = (kind: 'weekly' | 'urgent', weekKey: string | null, payload: unknown, d: { delivery: string; at: number | null; message: string | null }) =>
	Number(db().prepare('INSERT INTO digests (kind, week_key, created_at, payload, delivery, delivered_at, delivery_message) VALUES (?,?,?,?,?,?,?)').run(kind, weekKey, Date.now(), JSON.stringify(payload), d.delivery, d.at, d.message).lastInsertRowid);

/** The most recent occurrence (today included) of the digest weekday (0 = Sunday ... 6; default 1 = Monday). */
export function dueWeekKey(today: string, weekday = 1): string {
	const dow = new Date(today + 'T00:00:00Z').getUTCDay();
	return addDays(today, -((dow - weekday + 7) % 7));
}
const digestDay = () => { const n = Number(env('DIGEST_DAY', '1')); return Number.isInteger(n) && n >= 0 && n <= 6 ? n : 1; };

/**
 * Make this week's digest if it has not been made yet (a server that was off on Monday catches up as soon as it is on), store
 * it, and send it if a webhook is configured. `force` makes an extra one by hand.
 */
export async function runWeeklyDigest(o: { force?: boolean; fetchImpl?: typeof fetch; today?: string } = {}): Promise<{ id: number | null; created: boolean; delivery: string; message: string | null }> {
	const weekKey = dueWeekKey(o.today ?? pacificToday(), digestDay());
	const existing = o.force ? undefined : (db().prepare("SELECT id, payload, delivery FROM digests WHERE kind = 'weekly' AND week_key = ?").get(weekKey) as { id: number; payload: string; delivery: string } | undefined);
	if (existing) {
		// A digest whose delivery failed (webhook down on the day) is sent again, at most once an hour, until it gets through.
		const tried = Number((db().prepare("SELECT value FROM kv WHERE key = 'digest_retry'").get() as { value: string } | undefined)?.value ?? 0);
		if (existing.delivery !== 'failed' || !webhook().url || Date.now() - tried < 3600_000) return { id: null, created: false, delivery: 'none', message: 'This week\'s digest already exists.' };
		db().prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('digest_retry', ?)").run(String(Date.now()));
		const stored = JSON.parse(existing.payload) as Digest;
		const r = await postWebhook(renderText(stored, config.origin), stored, o.fetchImpl);
		db().prepare('UPDATE digests SET delivery = ?, delivered_at = ?, delivery_message = ? WHERE id = ?').run(r.ok ? 'sent' : 'failed', r.ok ? Date.now() : null, r.message, existing.id);
		return { id: existing.id, created: false, delivery: r.ok ? 'sent' : 'failed', message: r.message };
	}
	const digest = buildDigest();
	if (!digest.sites.length) return { id: null, created: false, delivery: 'none', message: 'There are no sites to report on yet.' };
	const w = webhook();
	let d = { delivery: 'none', at: null as number | null, message: null as string | null };
	if (w.url) {
		const r = await postWebhook(renderText(digest, config.origin), digest, o.fetchImpl);
		d = { delivery: r.ok ? 'sent' : 'failed', at: r.ok ? Date.now() : null, message: r.message };
	}
	const id = record('weekly', o.force ? null : weekKey, digest, d);
	audit('digest.created', { detail: `${o.force ? 'manual' : weekKey} · ${d.delivery}` });
	return { id, created: true, delivery: d.delivery, message: d.message };
}

const REALERT_MS = 14 * 86_400_000;

/**
 * Blocking problems should not wait for Monday. Each one is announced once; it is announced again only if it is still open two
 * weeks later. With a webhook, an item whose delivery failed is retried on the next run; without one, alerts still appear in the
 * app (Digest page) and are remembered, so they are not repeated.
 */
export async function runUrgentAlerts(o: { fetchImpl?: typeof fetch } = {}): Promise<{ alerted: number; delivery: string }> {
	const d = db();
	const fresh: { site: string; siteId: number; key: string; title: string; why: string; href: string }[] = [];
	for (const s of visibleSites()) {
		try {
			for (const a of queueFor(s).open.filter((x) => x.blocking)) {
				const last = d.prepare('SELECT sent_at FROM alerts_sent WHERE site_id = ? AND key = ?').get(s.id, a.key) as { sent_at: number } | undefined;
				if (!last || Date.now() - last.sent_at > REALERT_MS) fresh.push({ site: displayName(s.site_url), siteId: s.id, key: a.key, title: a.title, why: a.why, href: a.href });
			}
		} catch {
			/* skip a site that cannot be read */
		}
	}
	if (!fresh.length) return { alerted: 0, delivery: 'none' };
	// Only what the message actually shows is marked as announced: the rest waits for the next run instead of vanishing. Discord
	// cuts a message at 1,900 characters, so fewer are shown when they are long.
	const limit = webhook().format === 'discord' ? 1900 : Infinity;
	let n = Math.min(URGENT_SHOWN, fresh.length);
	while (n > 1 && renderUrgent(fresh.slice(0, n), config.origin, fresh.length - n).length > limit) n--;
	const rest = fresh.length - n;
	fresh.length = n;
	let delivery = 'none';
	let message: string | null = null;
	if (webhook().url) {
		const r = await postWebhook(renderUrgent(fresh, config.origin, rest), { urgent: fresh }, o.fetchImpl);
		delivery = r.ok ? 'sent' : 'failed';
		message = r.message;
		if (!r.ok) {
			// One failed row per few hours, not one per attempt, while a webhook is down.
			if (!d.prepare("SELECT 1 FROM digests WHERE kind = 'urgent' AND delivery = 'failed' AND created_at > ?").get(Date.now() - 6 * 3600_000)) record('urgent', null, { items: fresh.map(({ site, title, why, href }) => ({ site, title, why, href })) }, { delivery, at: null, message });
			return { alerted: 0, delivery }; // not remembered: tried again on the next run
		}
	}
	const mark = d.prepare('INSERT OR REPLACE INTO alerts_sent (site_id, key, sent_at) VALUES (?,?,?)');
	d.transaction(() => { for (const f of fresh) mark.run(f.siteId, f.key, Date.now()); })();
	record('urgent', null, { items: fresh.map(({ site, title, why, href }) => ({ site, title, why, href })) }, { delivery, at: delivery === 'sent' ? Date.now() : null, message });
	return { alerted: fresh.length, delivery };
}

