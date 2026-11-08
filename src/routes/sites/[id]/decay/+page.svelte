<script lang="ts">
	import Explainer from '$lib/components/Explainer.svelte';
	import DataTable from '$lib/components/DataTable.svelte';
	import Dumbbell from '$lib/components/viz/Dumbbell.svelte';
	import DecayMap from '$lib/components/viz/DecayMap.svelte';
	import { fmtSigned } from '$lib/format';
	import { page } from '$app/state';
	let { data } = $props();
	const yoy = $derived(data.mode === 'yoy');
	const link = (m: string) => { const u = new URL(page.url); u.searchParams.set('mode', m); return u.pathname + u.search; };
	const specific = $derived(data.rows.filter((r) => r.scope === 'page-specific').length);
	const pathOf = (u: string) => { try { return new URL(u).pathname; } catch { return u; } };
	/** the biggest losses first, as before -> now dots on one scale */
	const bells = $derived([...data.rows].sort((a, b) => b.lostClicks - a.lostClicks).map((r) => ({ label: pathOf(r.page), before: r.prevClicks, after: r.clicks, href: r.page, pii: true })));
	const cols = $derived([
		{ key: 'page', label: 'Page', type: 'link' as const },
		{ key: 'lostClicks', label: 'Lost clicks', type: 'int' as const },
		{ key: 'deltaPct', label: 'Δ clicks', type: 'delta' as const },
		{ key: 'relativeDeltaPct', label: 'vs site', type: 'delta' as const, title: 'Page change minus whole-site change' },
		...(yoy ? [] : [{ key: 'yoyDeltaPct', label: 'vs last year', type: 'delta' as const }]),
		{ key: 'prevClicks', label: yoy ? 'Last year' : 'Before', type: 'int' as const },
		{ key: 'clicks', label: 'Now', type: 'int' as const },
		{ key: 'positionPrev', label: 'Pos before', type: 'pos' as const },
		{ key: 'positionNow', label: 'Pos now', type: 'pos' as const },
		{ key: 'scope', label: 'Scope', type: 'text' as const }
	]);
</script>

<div class="mb-3 flex flex-wrap items-center gap-1.5 text-xs">
	<a class="chip {yoy ? '' : 'chip-on'}" href={link('period')}>vs the previous period</a>
	<a class="chip {yoy ? 'chip-on' : ''}" href={link('yoy')} title="The same weekdays one year earlier: catches the slow slide a month-on-month view misses">vs the same time last year</a>
</div>
<Explainer lead="Pages that lost clicks, and passed a significance test.">
	<p>Pages that lost 25%+ of clicks versus the {yoy ? 'same period a year earlier' : 'previous period'} <i>and</i> pass a significance test (a ±2σ Poisson check), so ordinary noise on low-traffic pages is ignored.
	Whole-site change over the period: <b class="text-[color:var(--foreground)]">{fmtSigned(data.siteDelta)}</b>.
	“site-wide” means the page fell with the whole site (look at seasonality or a site-level issue); “page-specific” means it fell more than the site did.
	{#if !data.hasYear}{yoy ? 'The year view' : 'Year-over-year'} needs 12+ months of stored history; it will appear once the backfill reaches that far.{/if}</p>
</Explainer>
<p class="mb-2 text-sm"><b>{data.rows.length}</b> decaying pages · <b>{specific}</b> page-specific</p>
{#if bells.length}<section class="card mb-4 p-4"><h2 class="mb-3 text-sm font-medium">Clicks {yoy ? 'a year ago' : 'before'} and now, biggest losses first</h2><Dumbbell rows={bells} better="up" beforeLabel={yoy ? 'a year ago' : 'before'} afterLabel="now" /></section>{/if}
{#if data.map.rows.length}
<details class="card mb-4 p-4" open={!data.rows.length}>
	<summary class="cursor-pointer text-sm font-medium select-none">Decay map: your biggest pages, week by week <span class="font-normal text-muted-foreground">· last {data.map.weeks.length} weeks</span></summary>
	<p class="mt-1 mb-3 text-xs text-muted-foreground">Each row is shaded against that page's own best week, so a slow slide shows as a row fading to the right, even on pages too small to pass the significance test above.</p>
	<DecayMap weeks={data.map.weeks} rows={data.map.rows} />
</details>
{/if}
<DataTable rows={data.rows} {cols} sortKey="lostClicks"  empty="No significant decay. Nothing lost more than 25% with statistical confidence." />
