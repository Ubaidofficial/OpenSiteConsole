<script lang="ts">
	import DataTable from '$lib/components/DataTable.svelte';
	import LineChart from '$lib/components/LineChart.svelte';
	import { fmtInt, fmtSigned } from '$lib/format';
	let { data } = $props();
	const views = [['movers', 'Winners & losers'], ['new', 'New & lost queries'], ['bands', 'Position bands'], ['questions', 'Questions'], ['trajectories', 'Trajectories'], ['forecast', 'Projection']] as const;
	const href = (v: string) => `?days=${data.days}&view=${v}`;
	const moverCols = (key: 'query' | 'page') => [
		{ key, label: key === 'query' ? 'Query' : 'Page', type: key === 'page' ? ('link' as const) : ('text' as const) },
		{ key: 'clicks', label: 'Clicks', type: 'int' as const },
		{ key: 'prevClicks', label: 'Before', type: 'int' as const },
		{ key: 'change', label: 'Change', type: 'int' as const, title: 'Clicks now minus clicks in the previous period. Only changes bigger than normal noise are listed.' },
		{ key: 'deltaPct', label: 'Δ %', type: 'delta' as const },
		{ key: 'position', label: 'Position', type: 'pos' as const }
	];
	const shape = (rows: { key: string }[], name: 'query' | 'page') => rows.map((r) => ({ ...r, [name]: r.key }));
	const dir: Record<string, string> = { rising: '▲ rising', falling: '▼ falling', flat: '– flat', volatile: '≈ volatile', 'too-little-data': 'too little data' };
	const dirTone: Record<string, string> = { rising: 'text-good', falling: 'text-bad', flat: 'text-muted-foreground', volatile: 'text-warn', 'too-little-data': 'text-muted-foreground' };
	const bandRows = $derived(data.bands ? data.bands.now.map((b, i) => ({ band: b.label, queries: b.queries, prevQueries: data.bands!.prev[i].queries, qDelta: b.queries - data.bands!.prev[i].queries, clicks: b.clicks, impressions: b.impressions })) : []);
	const fc = $derived(data.forecast);
	const xs = $derived(fc?.projection ? [...fc.weekly.slice(-12).map((w) => w.weekEnd), ...fc.projection.points.map((p) => p.weekEnd)] : []);
</script>

<nav class="mb-4 flex flex-wrap gap-1.5" aria-label="Trend views">
	{#each views as [v, label]}<a class="chip {data.view === v ? 'chip-on' : ''}" href={href(v)} data-sveltekit-noscroll>{label}</a>{/each}
</nav>

{#if data.view === 'movers' && data.movers}
	<p class="mb-3 text-xs text-muted-foreground">Compared with the previous {data.days} days. A row appears only if clicks changed by at least 10 and by more than normal day-to-day noise (a Poisson test, the same one the Decay tab uses), so a handful of clicks either way never shows.</p>
	<div class="grid grid-cols-1 gap-4 2xl:grid-cols-2">
		<section><h2 class="mb-1 font-medium text-good">Query winners</h2><DataTable rows={shape(data.movers.queries.winners, 'query')} cols={moverCols('query')} sortKey="change" filterable={false} pageSize={15} empty="No query moved by more than noise." /></section>
		<section><h2 class="mb-1 font-medium text-bad">Query losers</h2><DataTable rows={shape(data.movers.queries.losers, 'query')} cols={moverCols('query')} sortKey="change" sortDir="asc" filterable={false} pageSize={15} empty="No query moved by more than noise." /></section>
		<section><h2 class="mb-1 font-medium text-good">Page winners</h2><DataTable rows={shape(data.movers.pages.winners, 'page')} cols={moverCols('page')} sortKey="change" filterable={false} pageSize={15} empty="No page moved by more than noise." /></section>
		<section><h2 class="mb-1 font-medium text-bad">Page losers</h2><DataTable rows={shape(data.movers.pages.losers, 'page')} cols={moverCols('page')} sortKey="change" sortDir="asc" filterable={false} pageSize={15} empty="No page moved by more than noise." /></section>
	</div>
{:else if data.view === 'new' && data.added}
	<p class="mb-3 text-xs text-muted-foreground">Queries with at least 10 impressions in one period and none at all in the other. Google hides some queries entirely, so a query can appear here without being truly new.</p>
	<div class="grid grid-cols-1 gap-4 2xl:grid-cols-2">
		<section><h2 class="mb-1 font-medium">New queries</h2><DataTable rows={data.added.map((r) => ({ query: r.key, clicks: r.clicks, impressions: r.impressions, position: r.position }))} cols={[{ key: 'query', label: 'Query', type: 'text' }, { key: 'clicks', label: 'Clicks', type: 'int' }, { key: 'impressions', label: 'Impressions', type: 'int' }, { key: 'position', label: 'Position', type: 'pos' }]} sortKey="clicks" filterable={false} pageSize={15} empty="No new queries this period." /></section>
		<section><h2 class="mb-1 font-medium">Lost queries</h2><DataTable rows={data.lost.map((r) => ({ query: r.key, clicks: r.clicks, impressions: r.impressions, position: r.position }))} cols={[{ key: 'query', label: 'Query', type: 'text' }, { key: 'clicks', label: 'Clicks before', type: 'int' }, { key: 'impressions', label: 'Impressions before', type: 'int' }, { key: 'position', label: 'Position before', type: 'pos' }]} sortKey="clicks" filterable={false} pageSize={15} empty="No queries disappeared." /></section>
	</div>
{:else if data.view === 'bands'}
	<p class="mb-3 text-xs text-muted-foreground">Non-branded queries counted by average position. Growth in the top bands means more queries reaching page one; growth only in 51+ usually means more long-tail impressions.</p>
	<DataTable rows={bandRows} cols={[{ key: 'band', label: 'Position band', type: 'text' }, { key: 'queries', label: 'Queries', type: 'int', bar: true }, { key: 'prevQueries', label: 'Previous', type: 'int' }, { key: 'qDelta', label: 'Change', type: 'int' }, { key: 'clicks', label: 'Clicks', type: 'int' }, { key: 'impressions', label: 'Impressions', type: 'int' }]} sortKey="band" sortDir="asc" filterable={false} />
{:else if data.view === 'questions' && data.questions}
	<p class="mb-3 text-xs text-muted-foreground">
		<b>{fmtInt(data.questions.count)}</b> question-style queries (how, what, why, can… or containing “?”; English only, a heuristic) ·
		{(data.questions.clickShare * 100).toFixed(1)}% of clicks · {(data.questions.impressionShare * 100).toFixed(1)}% of impressions. These hint at the prompts people also put to AI assistants.
	</p>
	<DataTable rows={data.questions.rows} cols={[{ key: 'query', label: 'Question', type: 'text' }, { key: 'clicks', label: 'Clicks', type: 'int', bar: true }, { key: 'clicksDelta', label: 'Δ clicks', type: 'delta' }, { key: 'impressions', label: 'Impressions', type: 'int' }, { key: 'ctr', label: 'CTR', type: 'pct' }, { key: 'position', label: 'Position', type: 'pos' }]} sortKey="clicks" filterable={false} empty="No question-style queries yet." />
{:else if data.view === 'trajectories' && data.trajectories}
	<p class="mb-3 text-xs text-muted-foreground">Direction of weekly clicks over the last 12 complete weeks for the 25 biggest queries. The thresholds (±3% of the average per week, “volatile” when weeks swing by more than their average) are my own heuristics.</p>
	<div class="card overflow-x-auto">
		<table class="w-full"><thead><tr><th class="th">Query</th><th class="th text-right">Clicks (12 w)</th><th class="th">Direction</th><th class="th text-right">Weekly change</th><th class="th">Weekly clicks</th></tr></thead>
			<tbody>
				{#each data.trajectories as t (t.query)}
					{@const max = Math.max(1, ...t.weekly)}
					<tr>
						<td class="td">{t.query}</td><td class="td tnum text-right">{fmtInt(t.clicks)}</td>
						<td class="td text-xs {dirTone[t.direction]}">{dir[t.direction]}</td>
						<td class="td tnum text-right text-xs">{t.weeklyChangePct == null ? '–' : fmtSigned(t.weeklyChangePct / 100)}</td>
						<td class="td"><svg width="96" height="22" role="img" aria-label="weekly clicks">{#each t.weekly as v, i}<rect x={i * 8} y={22 - (v / max) * 20} width="6" height={Math.max(1, (v / max) * 20)} fill="var(--c-clicks)" opacity="0.7" />{/each}</svg></td>
					</tr>
				{:else}<tr><td class="td text-muted-foreground" colspan="5">No query data yet.</td></tr>{/each}
			</tbody></table>
	</div>
{:else if data.view === 'forecast' && fc}
	{#if !fc.projection}
		<div class="card p-6 text-center text-sm text-muted-foreground">A projection needs at least 8 complete weeks of stored history. This site has fewer so far.</div>
	{:else}
		{@const h = fc.weekly.slice(-12)}
		{@const last = h[h.length - 1].clicks}
		<p class="mb-2 text-sm">
			Weekly clicks over the next 8 weeks if recent behaviour continues: from about <b>{fmtInt(last)}</b> to <b>{fmtInt(fc.projection.points[7].clicks)}</b>
			(range {fmtInt(fc.projection.points[7].low)}–{fmtInt(fc.projection.points[7].high)}), a trend of {fmtSigned(fc.projection.weeklyTrendPct)} per week.
		</p>
		<div class="card mb-3 p-4">
			<LineChart
				{xs}
				series={[
					{ label: 'Weekly clicks', color: 'var(--c-clicks)', values: [...h.map((w) => w.clicks), ...fc.projection.points.map(() => null)] },
					{ label: 'Projection', color: 'var(--c-clicks)', dashed: true, values: [...h.map((_, i) => (i === h.length - 1 ? last : null)), ...fc.projection.points.map((p) => p.clicks)], lo: [...h.map(() => null), ...fc.projection.points.map((p) => p.low)], hi: [...h.map(() => null), ...fc.projection.points.map((p) => p.high)] },
					...(fc.lastYear ? [{ label: 'Same weeks last year', color: 'var(--muted-foreground)', values: [...h.map(() => null), ...fc.lastYear.map((p) => p.clicks)] }] : [])
				]}
			/>
		</div>
		<p class="text-xs text-muted-foreground">{fc.projection.method} The shaded band is about an 80% range if weekly clicks were normally distributed, which they are not exactly. <b>This is not a forecast</b>: it does not know about seasonality, planned changes or Google updates{fc.lastYear ? '; the grey line shows what the same weeks did last year, as a rough guide to seasonality' : ''}.</p>
	{/if}
{/if}
