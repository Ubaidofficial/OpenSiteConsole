/**
 * Three findings that need Clarity's stored daily snapshots, not just the newest one. Pure functions, unit-tested.
 *
 *  - botHeavyPages: pages where a large share of Clarity's sessions are bots, so every other number about them is suspect.
 *  - deviceFriction: a device class whose visitors hit rage or dead clicks clearly more often than the others'.
 *  - frictionAroundChanges: friction before and after each change in the change log.
 *
 * Clarity's export is coarse (counts of sessions for the last 24 hours, one snapshot per day), so everything here is a lead to check,
 * says so, and stays silent below a floor of sessions rather than reporting noise. Friction means sessions with rage clicks or with dead
 * clicks; the larger of the two counts is used because one session can have both and must not be counted twice (a lower bound).
 */
import { pathKey, type ClarityPage } from './pageinsights';

type Metrics = { metricName: string; information: Record<string, string | number>[] }[];

const num = (v: unknown) => {
	const n = Number(v);
	return v === undefined || v === '' || !Number.isFinite(n) ? null : n;
};
const frictionOf = (p: { rageClicks: number | null; deadClicks: number | null }) => Math.max(p.rageClicks ?? 0, p.deadClicks ?? 0);

/** Two-proportion z statistic with a pooled rate: how far apart x1/n1 and x2/n2 are, in standard errors. 0 when it cannot be told. */
export function twoProportionZ(x1: number, n1: number, x2: number, n2: number): number {
	if (n1 <= 0 || n2 <= 0) return 0;
	const p = (x1 + x2) / (n1 + n2);
	const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
	return se > 0 ? (x2 / n2 - x1 / n1) / se : 0;
}

// ── bots ─────────────────────────────────────────────────────────────────────
export interface BotPage { page: string; sessions: number; botSessions: number; share: number }

/**
 * Pages where bots are at least `minShare` of the sessions Clarity recorded, most bot sessions first. The share assumes the session
 * total counts bot sessions too (the demo data does; check Clarity's own documentation). Nothing is reported for a page when Clarity
 * gave no bot count for it, so a missing field never reads as "no bots".
 */
export function botHeavyPages(pages: ClarityPage[], o: { minSessions?: number; minShare?: number; limit?: number } = {}): BotPage[] {
	const { minSessions = 50, minShare = 0.25, limit = 25 } = o;
	return pages
		.filter((p) => p.sessions != null && p.sessions >= minSessions && p.botSessions != null && p.botSessions > 0)
		.map((p) => ({ page: pathKey(p.url), sessions: p.sessions!, botSessions: Math.min(p.botSessions!, p.sessions!), share: Math.min(p.botSessions!, p.sessions!) / p.sessions! }))
		.filter((p) => p.share >= minShare)
		.sort((a, b) => b.botSessions - a.botSessions || a.page.localeCompare(b.page))
		.slice(0, limit);
}

// ── devices ──────────────────────────────────────────────────────────────────
export type Device = 'mobile' | 'desktop' | 'tablet';
export interface DeviceRow { device: Device; sessions: number; frictionSessions: number }

/** Clarity calls desktop "PC" and Search Console calls it "DESKTOP"; anything else (email clients, car browsers) is left out. */
export function normDevice(s: string): Device | null {
	const v = s.trim().toLowerCase();
	return v === 'mobile' ? 'mobile' : v === 'pc' || v === 'desktop' ? 'desktop' : v === 'tablet' ? 'tablet' : null;
}

/** Per-device sessions and friction sessions out of a Clarity "by Device" snapshot. */
export function clarityDevices(metrics: Metrics): DeviceRow[] {
	const by = new Map<Device, { sessions: number; rage: number | null; dead: number | null }>();
	for (const m of metrics) {
		const field = m.metricName === 'Traffic' ? 'totalSessionCount' : m.metricName === 'RageClickCount' || m.metricName === 'DeadClickCount' ? 'sessionsCount' : null;
		if (!field) continue;
		for (const row of m.information ?? []) {
			const key = Object.keys(row).find((k) => k.toLowerCase() === 'device');
			const dev = key ? normDevice(String(row[key])) : null;
			const v = num(row[field]);
			if (!dev || v === null) continue;
			const cur = by.get(dev) ?? { sessions: 0, rage: null, dead: null };
			if (m.metricName === 'Traffic') cur.sessions += v;
			else if (m.metricName === 'RageClickCount') cur.rage = (cur.rage ?? 0) + v;
			else cur.dead = (cur.dead ?? 0) + v;
			by.set(dev, cur);
		}
	}
	return [...by].map(([device, c]) => ({ device, sessions: c.sessions, frictionSessions: frictionOf({ rageClicks: c.rage, deadClicks: c.dead }) }));
}

export interface DeviceFriction { device: Device; sessions: number; rate: number; otherRate: number; ratio: number; extraSessions: number; googleClickShare: number }

/**
 * Devices whose friction rate is at least `minRatio` times that of all the other devices together, clearly beyond chance (z of at least
 * `minZ`), with enough sessions on both sides and a real share of Google's clicks, so the audience is one the search traffic actually
 * sends. Biggest excess first. `googleClicks` is Search Console's web clicks per device for the window.
 */
export function deviceFriction(devices: DeviceRow[], googleClicks: Partial<Record<Device, number>>, o: { minSessions?: number; minRate?: number; minRatio?: number; minZ?: number; minClickShare?: number } = {}): DeviceFriction[] {
	const { minSessions = 100, minRate = 0.02, minRatio = 1.5, minZ = 2, minClickShare = 0.1 } = o;
	const totalClicks = Object.values(googleClicks).reduce((a, b) => a + (b ?? 0), 0);
	const out: DeviceFriction[] = [];
	for (const d of devices) {
		const others = devices.filter((x) => x.device !== d.device);
		const oS = others.reduce((a, x) => a + x.sessions, 0);
		const oF = others.reduce((a, x) => a + x.frictionSessions, 0);
		if (d.sessions < minSessions || oS < minSessions) continue;
		const rate = d.frictionSessions / d.sessions;
		const otherRate = oF / oS;
		const share = totalClicks > 0 ? (googleClicks[d.device] ?? 0) / totalClicks : 0;
		if (rate < minRate || share < minClickShare) continue;
		const ratio = otherRate > 0 ? rate / otherRate : Infinity;
		if (ratio < minRatio || twoProportionZ(oF, oS, d.frictionSessions, d.sessions) < minZ) continue;
		out.push({ device: d.device, sessions: d.sessions, rate, otherRate, ratio: Number.isFinite(ratio) ? ratio : 99, extraSessions: Math.round(d.frictionSessions - otherRate * d.sessions), googleClickShare: share });
	}
	return out.sort((a, b) => b.extraSessions - a.extraSessions || a.device.localeCompare(b.device));
}

// ── friction around logged changes ───────────────────────────────────────────
export interface PageSnapshot { day: string; pages: ClarityPage[] }
export interface LoggedChange { id: number; date: string; title: string; page_prefix: string | null }
export type FrictionVerdict = 'worse' | 'better' | 'no clear change' | 'too little data';
export interface FrictionChange {
	id: number;
	date: string;
	title: string;
	/** the pages the change covers, as logged; null = the whole site */
	scope: string | null;
	snapshotsBefore: number;
	snapshotsAfter: number;
	sessionsBefore: number;
	sessionsAfter: number;
	rateBefore: number;
	rateAfter: number;
	verdict: FrictionVerdict;
}

/** Does a path fall under a logged page prefix (a full address or a path)? A prefix ending in "/" means that folder and the folder's own page. */
export function inScope(path: string, prefix: string | null): boolean {
	if (!prefix) return true;
	let pre = prefix.trim();
	try {
		pre = new URL(pre).pathname;
	} catch {
		/* a path already */
	}
	if (!pre.startsWith('/')) pre = '/' + pre;
	const p = pathKey(path);
	return pre.endsWith('/') ? p === pre.slice(0, -1) || p.startsWith(pre) : p.startsWith(pre);
}

/**
 * For each change, the friction rate (sessions with rage or dead clicks per session) over the pages it covers in the snapshots from before
 * it and from after it. A snapshot dated D covers the 24 hours before it was fetched, so the days D (which may include part of the change
 * day) and D+1 (which includes the change day) are set aside: "before" is snapshots dated before D, "after" is snapshots dated after D+1.
 * A verdict needs at least `minSnapshots` snapshots and `minSessions` sessions on each side; below that the row says "too little data",
 * and a difference under one percentage point or under `minZ` standard errors says "no clear change". Newest change first.
 */
export function frictionAroundChanges(snaps: PageSnapshot[], changes: LoggedChange[], o: { minSnapshots?: number; minSessions?: number; minZ?: number; minDiff?: number; limit?: number } = {}): FrictionChange[] {
	const { minSnapshots = 3, minSessions = 100, minZ = 2, minDiff = 0.01, limit = 20 } = o;
	const addDay = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86_400_000).toISOString().slice(0, 10);
	const out: FrictionChange[] = [];
	for (const c of changes) {
		const after0 = addDay(c.date, 2);
		const side = (keep: (day: string) => boolean) => {
			let n = 0, sessions = 0, friction = 0;
			for (const s of snaps) {
				if (!keep(s.day)) continue;
				let ss = 0, ff = 0;
				for (const p of s.pages) {
					if (!inScope(p.url, c.page_prefix) || p.sessions == null) continue;
					ss += p.sessions;
					ff += frictionOf(p);
				}
				if (ss > 0) (n++, (sessions += ss), (friction += ff));
			}
			return { n, sessions, friction };
		};
		const b = side((d) => d < c.date);
		const a = side((d) => d >= after0);
		if (b.n === 0 || a.n === 0) continue;
		const enough = b.n >= minSnapshots && a.n >= minSnapshots && b.sessions >= minSessions && a.sessions >= minSessions;
		const rateBefore = b.friction / b.sessions;
		const rateAfter = a.friction / a.sessions;
		const z = enough ? twoProportionZ(b.friction, b.sessions, a.friction, a.sessions) : 0;
		const verdict: FrictionVerdict = !enough ? 'too little data' : Math.abs(z) < minZ || Math.abs(rateAfter - rateBefore) < minDiff ? 'no clear change' : z > 0 ? 'worse' : 'better';
		out.push({ id: c.id, date: c.date, title: c.title, scope: c.page_prefix, snapshotsBefore: b.n, snapshotsAfter: a.n, sessionsBefore: b.sessions, sessionsAfter: a.sessions, rateBefore, rateAfter, verdict });
	}
	return out.sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : y.id - x.id)).slice(0, limit);
}
