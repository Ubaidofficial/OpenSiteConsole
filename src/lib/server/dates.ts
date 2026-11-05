/** Search Console buckets days in Pacific time, so "today" must be computed there. */
export function pacificToday(now: Date = new Date()): string {
	const parts = new Intl.DateTimeFormat('en-CA', {
		timeZone: 'America/Los_Angeles',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	}).format(now);
	return parts; // en-CA yields YYYY-MM-DD
}

const DAY = 86_400_000;

function toUtc(date: string): number {
	const [y, m, d] = date.split('-').map(Number);
	return Date.UTC(y, m - 1, d);
}

export function addDays(date: string, n: number): string {
	return new Date(toUtc(date) + n * DAY).toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
	return Math.round((toUtc(b) - toUtc(a)) / DAY);
}

export function addMonths(date: string, n: number): string {
	const [y, m, d] = date.split('-').map(Number);
	const t = new Date(Date.UTC(y, m - 1 + n, 1));
	const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
	t.setUTCDate(Math.min(d, last));
	return t.toISOString().slice(0, 10);
}

export function eachDay(start: string, end: string): string[] {
	const out: string[] = [];
	for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
	return out;
}

/** Search Console keeps roughly 16 months; this is the oldest date worth requesting. */
export function retentionHorizon(today: string): string {
	return addDays(addMonths(today, -16), 1);
}

export interface Period {
	start: string;
	end: string;
	prevStart: string;
	prevEnd: string;
	days: number;
}

/** A period of `days` ending at `end`, plus the equally long period right before it. */
export function makePeriod(end: string, days: number): Period {
	const start = addDays(end, -(days - 1));
	const prevEnd = addDays(start, -1);
	const prevStart = addDays(prevEnd, -(days - 1));
	return { start, end, prevStart, prevEnd, days };
}
