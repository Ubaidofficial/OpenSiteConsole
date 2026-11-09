/**
 * "Ask your data": what the chat page and the chat server share. Pure, unit-tested.
 *
 * The server streams newline-delimited JSON events (ChatEvent) while a turn runs; a stored conversation is turned into the same
 * display items (ChatItem) when the page loads, so a reloaded conversation looks exactly like a live one.
 */

export interface ChartSeries { name: string; values: number[] }
export interface ChartSpec { type: 'line' | 'bar'; title: string; labels: string[]; series: ChartSeries[]; y_label?: string }

export interface ToolActivity { id: string; name: string; label: string; status: 'running' | 'done' | 'error' | 'declined'; error?: string }
export interface ApprovalItem { id: string; name: string; label: string; input: Record<string, unknown> }

export type ChatItem =
	| { kind: 'user'; text: string }
	| { kind: 'text'; text: string }
	| { kind: 'tool'; tool: ToolActivity }
	| { kind: 'chart'; chart: ChartSpec };

export type ChatEvent =
	| { type: 'thread'; id: number; title: string }
	| { type: 'text'; text: string }
	/** a new assistant text block begins (so two blocks are not run together) */
	| { type: 'break' }
	| { type: 'tool'; tool: ToolActivity }
	| { type: 'chart'; chart: ChartSpec }
	| { type: 'approval'; items: ApprovalItem[] }
	| { type: 'error'; message: string }
	| { type: 'done' };

export const MAX_CHART_POINTS = 120;
export const MAX_CHART_SERIES = 4;

/** The chart the model asked to show, checked before it is drawn. Returns the reason when it cannot be. */
export function validateChart(input: unknown): { chart: ChartSpec } | { error: string } {
	const x = (input ?? {}) as Record<string, unknown>;
	const type = x.type === 'bar' ? 'bar' : x.type === 'line' ? 'line' : null;
	if (!type) return { error: '`type` must be "line" or "bar".' };
	const title = String(x.title ?? '').trim().slice(0, 120);
	if (!title) return { error: '`title` is required.' };
	if (!Array.isArray(x.labels) || x.labels.length < 2) return { error: '`labels` must list at least two x-axis labels.' };
	if (x.labels.length > MAX_CHART_POINTS) return { error: `At most ${MAX_CHART_POINTS} points: aggregate first (weeks or months instead of days).` };
	const labels = x.labels.map((l) => String(l).slice(0, 40));
	if (!Array.isArray(x.series) || x.series.length < 1 || x.series.length > MAX_CHART_SERIES) return { error: `\`series\` must have 1 to ${MAX_CHART_SERIES} entries.` };
	const series: ChartSeries[] = [];
	for (const s of x.series as Record<string, unknown>[]) {
		const name = String(s?.name ?? '').trim().slice(0, 60) || `Series ${series.length + 1}`;
		if (!Array.isArray(s?.values) || s.values.length !== labels.length) return { error: `Series "${name}" must have one value per label (${labels.length}).` };
		const values = s.values.map(Number);
		if (values.some((v) => !Number.isFinite(v))) return { error: `Series "${name}" has a value that is not a number.` };
		series.push({ name, values });
	}
	const y = typeof x.y_label === 'string' && x.y_label.trim() ? x.y_label.trim().slice(0, 40) : undefined;
	return { chart: { type, title, labels, series, ...(y ? { y_label: y } : {}) } };
}

const SPECIAL: Record<string, string> = {
	list_sites: 'Listed your sites', get_action_queue: 'Read the to-do list', get_quick_wins: 'Found quick wins', get_opportunities: 'Looked for opportunities',
	get_portfolio: 'Compared all sites', get_overview: 'Read the overview', get_performance: 'Queried search performance', get_trends: 'Checked trends',
	get_history: 'Read the history', get_page_insights: 'Joined page data', inspect_url: 'Inspected a URL with Google', show_chart: 'Drew a chart',
	get_ai_visibility: 'Read AI answers', get_ai_traffic: 'Read AI assistant traffic', get_bing_performance: 'Read Bing data'
};
/** A short, human label for a tool call ("Found quick wins · greenleaf.example"), shown while it runs and in the history. */
export function toolLabel(name: string, input: Record<string, unknown> = {}, siteName?: (ref: unknown) => string | null): string {
	const base = SPECIAL[name] ?? (() => {
		const words = name.replace(/^get_/, '').replace(/_/g, ' ');
		return name.startsWith('get_') ? `Read ${words}` : words.charAt(0).toUpperCase() + words.slice(1);
	})();
	const extra: string[] = [];
	const site = input.site != null && siteName ? siteName(input.site) : null;
	if (site) extra.push(site);
	for (const k of ['view', 'type', 'dimension'] as const) if (typeof input[k] === 'string') extra.push(String(input[k]).replace(/_/g, ' '));
	return extra.length ? `${base} · ${extra.join(' · ')}` : base;
}

/** Questions to start with, chosen to show what the chat can do across tools. */
export const STARTERS: { title: string; prompt: string }[] = [
	{ title: 'What should I fix first?', prompt: 'What should I fix first across my sites? Give me the top 5 with the reason for each.' },
	{ title: 'Why did clicks change?', prompt: 'Did clicks drop or grow on any of my sites in the last 28 days? Find the cause: which pages and queries moved.' },
	{ title: 'Month by month', prompt: 'Chart my clicks month by month and tell me the biggest winners and losers of the last month.' },
	{ title: 'Quick wins this week', prompt: 'Which quick wins could I ship this week? Prioritise by estimated extra clicks.' },
	{ title: 'Rewrite weak titles', prompt: 'Find pages with a low CTR for their position and suggest better title tags, using the queries they rank for.' },
	{ title: 'AI assistants', prompt: 'How much traffic do AI assistants send me, and what do they say about my brand?' }
];
