<script lang="ts">
	import { enhance } from '$app/forms';
	import { tick } from 'svelte';
	import DataTable from '$lib/components/DataTable.svelte';
	import OppScatter from '$lib/components/viz/OppScatter.svelte';
	import CtrCurve from '$lib/components/viz/CtrCurve.svelte';
	import Dumbbell from '$lib/components/viz/Dumbbell.svelte';
	import { fmtInt, fmtPct } from '$lib/format';
	import { HIDDEN_GROUPS, HIDDEN_INTRO, HIDDEN_SOURCE_HINT } from '$lib/explain';
	let { data, form } = $props();
	const sCols = $derived([
		{ key: 'query', label: 'Query', type: 'text' as const },
		{ key: 'expectedGain', label: 'Est. +clicks', type: 'int' as const, bar: true, title: 'Extra clicks per period if this query reached position 3, using your own CTR curve' },
		{ key: 'impressions', label: 'Impressions', type: 'int' as const },
		{ key: 'clicks', label: 'Clicks', type: 'int' as const },
		{ key: 'ctr', label: 'CTR', type: 'pct' as const },
		{ key: 'position', label: 'Position', type: 'pos' as const },
		...(data.hasVolumes ? [{ key: 'volume', label: 'Volume', type: 'int' as const, title: 'Monthly searches, from OpenSEO (fetch them on the Queries tab)' }, { key: 'kd', label: 'KD', type: 'int' as const, title: 'Keyword difficulty from OpenSEO, 0 to 100' }] : [])
	]);
	const gCols = [
		{ key: 'query', label: 'Query', type: 'text' as const },
		{ key: 'page', label: 'Page', type: 'link' as const },
		{ key: 'missedClicks', label: 'Missed clicks', type: 'int' as const, bar: true },
		{ key: 'ctr', label: 'CTR', type: 'pct' as const },
		{ key: 'expectedCtr', label: 'Expected', type: 'pct' as const, title: 'The click-through rate this site normally earns at that position, from its own data.' },
		{ key: 'position', label: 'Position', type: 'pos' as const },
		{ key: 'impressions', label: 'Impressions', type: 'int' as const }
	];
	const num = (k: string, label: string, type: 'int' | 'pct' | 'pos', title?: string, bar = false) => ({ key: k, label, type, title, bar });
	const qcol = { key: 'query', label: 'Search', type: 'text' as const };
	const pcol = { key: 'page', label: 'Page', type: 'text' as const, pii: true };
	const h = $derived(data.hidden);
	const tables = $derived([
		{ id: 'lost', rows: h.lost, sort: 'lostClicks', cols: [qcol, num('lostClicks', 'Clicks lost', 'int', undefined, true), num('prevClicks', 'Before', 'int'), num('clicks', 'Now', 'int'), num('positionPrev', 'Position before', 'pos'), num('positionNow', 'Position now', 'pos')], src: 'previousPeriod' as const },
		{ id: 'rising', rows: h.rising, sort: 'gain', cols: [qcol, num('gain', 'Est. +clicks at #5', 'int', 'Extra clicks per period if this search reached position 5, on your own click curve', true), num('impressions', 'Impressions', 'int'), num('prevImpressions', 'Before', 'int'), num('position', 'Position', 'pos')], src: 'previousPeriod' as const },
		{ id: 'edge', rows: h.pageEdge, sort: 'gain', cols: [pcol, num('gain', 'Est. +clicks at #5', 'int', 'Ceiling: every search listed for this page reaching position 5 at once', true), num('queries', 'Searches', 'int'), num('impressions', 'Impressions', 'int')], src: null },
		{ id: 'questions', rows: h.questions, sort: 'gain', cols: [qcol, num('gain', 'Est. +clicks at #5', 'int', undefined, true), num('impressions', 'Impressions', 'int'), num('position', 'Position', 'pos')], src: null },
		{ id: 'bing', rows: h.bingGaps, sort: 'bingImpressions', cols: [qcol, num('bingImpressions', 'Bing impressions', 'int', undefined, true), num('bingPosition', 'Bing position', 'pos'), num('googlePosition', 'Google position', 'pos', 'Blank means Google shows you nowhere for it'), num('googleImpressions', 'Google impressions', 'int')], src: 'bing' as const },
		{ id: 'notbing', rows: h.notInBing, sort: 'clicks', cols: [pcol, num('clicks', 'Google clicks', 'int', undefined, true)], src: 'bing' as const },
		{ id: 'gems', rows: h.gems, sort: 'gain', cols: [pcol, num('gain', 'Est. +clicks at #3', 'int', undefined, true), num('sessions', 'Organic sessions', 'int'), num('engagementRate', 'Engaged', 'pct'), num('keyEventRate', 'Key events / session', 'pct'), num('position', 'Position', 'pos')], src: 'ga4' as const },
		{ id: 'leaks', rows: h.engagement, sort: 'lostEngagedSessions', cols: [pcol, num('lostEngagedSessions', 'Visits that would have engaged', 'int', 'If this page engaged visitors at your site-wide rate', true), num('sessions', 'Organic sessions', 'int'), num('engagementRate', 'Engaged', 'pct'), num('siteRate', 'Site average', 'pct')], src: 'ga4' as const },
		{ id: 'noconv', rows: h.conversions, sort: 'expectedKeyEvents', cols: [pcol, num('expectedKeyEvents', 'Expected key events', 'int', 'What this page would have produced at your site-wide rate', true), num('sessions', 'Organic sessions', 'int')], src: 'ga4' as const },
		{ id: 'friction', rows: h.friction, sort: 'rate', cols: [pcol, num('rate', 'Sessions with friction', 'pct', undefined, true), num('sessions', 'Sessions', 'int'), num('googleClicks', 'Google clicks', 'int')], src: 'clarity' as const },
		{ id: 'device', rows: h.device, sort: 'gain', cols: [qcol, num('gain', 'Est. +clicks', 'int', undefined, true), num('mobilePosition', 'Phone position', 'pos'), num('desktopPosition', 'Desktop position', 'pos'), num('mobileImpressions', 'Phone impressions', 'int')], src: null }
	].map((t) => ({ ...t, rows: t.rows as unknown as Record<string, unknown>[], ...HIDDEN_GROUPS.find((g) => g.id === t.id)! })));

	/**
	 * One list of every kind of opportunity, the two Search Console tables first. The page opens on a grid of tiles (what was found,
	 * how many, the biggest estimate); each table opens from its tile, so the tab is one screen instead of thirteen tables.
	 */
	const GAIN_KEYS = new Set(['expectedGain', 'missedClicks', 'gain', 'lostClicks', 'lostEngagedSessions', 'expectedKeyEvents']);
	const UNIT: Record<string, string> = { expectedGain: 'clicks', missedClicks: 'clicks', gain: 'clicks', lostClicks: 'clicks lost', lostEngagedSessions: 'engaged visits', expectedKeyEvents: 'key events' };
	const sections = $derived([
		{ id: 'striking', title: 'Striking distance', blurb: 'Searches at positions 4 to 20, ranked by the extra clicks position 3 would bring on your own click curve.', rows: data.striking as unknown as Record<string, unknown>[], cols: sCols, sort: 'expectedGain', src: null },
		{ id: 'ctr', title: 'Title and snippet fixes', blurb: 'Pages earning far fewer clicks than your site normally gets at that position: the snippet is the weak part, not the ranking.', rows: data.ctrGaps as unknown as Record<string, unknown>[], cols: gCols, sort: 'missedClicks', src: null },
		...tables
	].map((t) => {
		const missing = !!t.src && h.sources[t.src as keyof typeof h.sources] !== 'ok';
		const best = !missing && t.rows.length && GAIN_KEYS.has(t.sort) ? Math.max(...t.rows.map((r) => Number(r[t.sort]) || 0)) : null;
		return { ...t, missing, best, unit: UNIT[t.sort] ?? '' };
	}));
	const found = $derived(sections.filter((t) => !t.missing && t.rows.length));
	const none = $derived(sections.filter((t) => !t.missing && !t.rows.length));
	const needs = $derived(sections.filter((t) => t.missing));
	/** The tiles pick which list is shown under them; the first kind found is shown to start with. */
	let picked = $state<string | null>(null);
	const sel = $derived(found.find((t) => t.id === picked) ?? found[0] ?? null);
	/** Lists that are about a change get a before -> after picture above their table. */
	const bell = $derived.by(() => {
		if (!sel) return null;
		const r = sel.rows as Record<string, number & string>[];
		if (sel.id === 'lost') return { rows: r.slice(0, 8).map((x) => ({ label: String(x.query), before: Number(x.prevClicks), after: Number(x.clicks), pii: true })), better: 'up' as const, before: 'clicks before', after: 'clicks now', format: (v: number) => Math.round(v).toLocaleString('en-US'), change: 'pct' as const, unit: '' };
		if (sel.id === 'rising') return { rows: r.slice(0, 8).map((x) => ({ label: String(x.query), before: Number(x.prevImpressions), after: Number(x.impressions), pii: true })), better: 'up' as const, before: 'impressions before', after: 'impressions now', format: (v: number) => Math.round(v).toLocaleString('en-US'), change: 'pct' as const, unit: '' };
		if (sel.id === 'device') return { rows: r.slice(0, 8).map((x) => ({ label: String(x.query), before: Number(x.desktopPosition), after: Number(x.mobilePosition), pii: true })), better: 'down' as const, before: 'desktop position', after: 'phone position', format: (v: number) => v.toFixed(1), change: 'abs' as const, unit: 'places' };
		return null;
	});
	const pick = async (id: string) => {
		picked = id;
		await tick();
		document.getElementById('op-list')?.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
	};
	const SRC_LABEL: Record<string, string> = { previousPeriod: 'the previous period', bing: 'Bing', ga4: 'GA4', clarity: 'Clarity' };
</script>

<div class="mb-4 flex flex-wrap items-end gap-x-4 gap-y-1">
	<div>
		<h2 class="text-lg font-semibold tracking-tight">{found.length} kinds of opportunity found</h2>
		<p class="text-sm text-muted-foreground">Pick a kind to see its list. Estimates use this site's own click curve: model figures, not promises.</p>
	</div>
</div>

<div class="mb-6 grid grid-cols-1 gap-4 xl:grid-cols-5">
	<section class="card p-4 xl:col-span-3" aria-labelledby="scatter-h">
		<h3 id="scatter-h" class="text-sm font-medium">Where the opportunities are</h3>
		<p class="mb-2 text-xs text-muted-foreground">Each dot is a search: further left ranks higher, higher up is seen more, bigger is worth more. Hover for details.</p>
		<OppScatter points={data.striking.slice(0, 60).map((r) => ({ label: r.query, position: r.position, impressions: r.impressions, gain: r.expectedGain }))} />
	</section>
	<section class="card p-4 xl:col-span-2" aria-labelledby="curve-h">
		<h3 id="curve-h" class="text-sm font-medium">Is your click rate normal for the position? <span class="chip ml-1 font-normal">{data.curve.source === 'fitted' ? 'fitted to your data' : data.curve.source === 'mixed' ? 'partly fitted' : 'industry default'}</span></h3>
		<p class="mb-2 text-xs text-muted-foreground">Non-branded searches only. Dots below the line are snippets that earn fewer clicks than your site normally does there.</p>
		<CtrCurve values={data.curve.values} fitted={data.curve.fitted} points={data.ctrGaps.slice(0, 20).map((g) => ({ label: g.query, position: g.position, ctr: g.ctr }))} />
	</section>
</div>

<div class="stagger mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
	{#each found as t (t.id)}
		<button type="button" onclick={() => pick(t.id)} aria-pressed={sel?.id === t.id} aria-controls="op-list" class="card block p-4 text-left transition-colors hover:border-[color:var(--link)] {sel?.id === t.id ? 'border-[color:var(--link)] ring-1 ring-[color:var(--link)]' : ''}">
			<div class="flex items-baseline gap-2"><span class="font-medium">{t.title}</span><span class="chip ml-auto">{fmtInt(t.rows.length)}</span></div>
			<p class="mt-1 line-clamp-2 text-xs text-muted-foreground">{t.blurb}</p>
			{#if t.best != null}<p class="tnum mt-2 text-sm"><span class="text-muted-foreground">Biggest:</span> <b>≈ {fmtInt(Math.round(t.best))}</b> <span class="text-muted-foreground">{t.unit}</span></p>{/if}
		</button>
	{/each}
</div>

{#if sel}
	<section id="op-list" class="card mb-6 scroll-mt-20 p-4" aria-live="polite">
		<div class="mb-1 flex flex-wrap items-baseline gap-2"><h3 class="font-medium">{sel.title}</h3><span class="chip">{fmtInt(sel.rows.length)}</span>{#if sel.best != null}<span class="tnum ml-auto text-xs text-muted-foreground">biggest ≈ {fmtInt(Math.round(sel.best))} {sel.unit}</span>{/if}</div>
		<p class="mb-3 max-w-3xl text-xs text-muted-foreground">{sel.blurb}</p>
		{#if bell}<div class="mb-4 max-w-3xl">{#key sel.id}<Dumbbell rows={bell.rows} better={bell.better} beforeLabel={bell.before} afterLabel={bell.after} format={bell.format} change={bell.change} unit={bell.unit} />{/key}</div>{/if}
		{#key sel.id}<DataTable rows={sel.rows} cols={sel.cols} sortKey={sel.sort} pageSize={15} />{/key}
	</section>
{/if}
{#if data.openseo}
	<section id="openseo-track" class="card mb-6 scroll-mt-20 p-4 text-sm">
		<h3 class="mb-1 font-medium">Track striking-distance searches in OpenSEO</h3>
		<p class="mb-2 text-xs text-muted-foreground">Sends your best non-brand searches at positions 4 to 20 to the rank tracker of <span class="pii">{data.openseo.project ?? 'the linked project'}</span>, for daily positions and competitors. {data.openseo.tracked ? `${data.openseo.tracked} sent so far; they are not sent again.` : ''} Preview first: it shows OpenSEO's own cost estimate and changes nothing.</p>
		{#if data.openseo.candidates}
			<form method="POST" action="?/oseoPreview" use:enhance class="flex flex-wrap items-center gap-2 text-xs">
				<label class="flex items-center gap-1.5">Top <input class="input w-20" type="number" name="n" min="1" max={data.openseo.max} value="25" /> searches</label>
				<button class="btn !h-8 text-xs">Preview</button>
			</form>
		{:else}<p class="text-xs text-muted-foreground">No striking-distance searches left to send.</p>{/if}
		{#if form?.plan}
			{@const p = form.plan}
			<div class="mt-3 rounded border p-3 text-xs" style="border-color:var(--border)">
				<p class="mb-1">{p.action === 'create' ? 'No tracker for this domain yet: a new manual tracker (mobile, top 40 results) will be created. A manual tracker has no recurring cost; positions appear when you run a check in OpenSEO.' : `Adds to the existing ${p.schedule} tracker.`} Adding keywords also makes OpenSEO fetch their volume, which uses credits.</p>
				{#if p.estimate}<p class="mb-1">OpenSEO's estimate: one check after adding costs at most <b>${p.estimate.costUsd.toFixed(4)}</b> ({p.estimate.costCredits} credits){#if p.estimate.scheduled}; its {p.estimate.scheduled.interval} checks cost at most <b>{p.estimate.scheduled.costCredits} credits</b> each, up to about ${p.estimate.scheduled.monthlyCostUsd.toFixed(2)} a month{/if}.</p>{/if}
				<details class="mb-2"><summary class="cursor-pointer text-muted-foreground">{p.keywords.length} searches</summary><p class="pii mt-1">{p.keywords.join(' · ')}</p></details>
				<form method="POST" action="?/oseoTrack" use:enhance>
					<input type="hidden" name="keywords" value={p.keywords.join('\n')} />
					{#if p.estimate?.scheduled}<input type="hidden" name="credits" value={p.estimate.scheduled.costCredits} />{/if}
					<button class="btn btn-primary !h-8 text-xs">Send {p.keywords.length} searches{p.estimate?.scheduled ? `, up to ${p.estimate.scheduled.costCredits} credits per check` : ''}</button>
				</form>
			</div>
		{/if}
		{#if form?.ok}<p class="mt-2 text-xs text-good">{form.ok}{#if form.trackerUrl} <a class="underline" href={form.trackerUrl} target="_blank" rel="noreferrer noopener">Open the tracker</a>{/if}</p>{/if}
		{#if form?.error}<p class="mt-2 text-xs text-bad">{form.error}</p>{/if}
	</section>
{/if}
{#if none.length || needs.length}
	<div class="mb-6 space-y-1 text-xs text-muted-foreground">
		{#if none.length}<p><b class="font-medium text-foreground">Nothing found this period:</b> {none.map((t) => t.title).join(', ')}.</p>{/if}
		{#each ['previousPeriod', 'bing', 'ga4', 'clarity'] as const as k}
			{@const ts = needs.filter((t) => t.src === k)}
			{#if ts.length}<p><b class="font-medium text-foreground">Needs {SRC_LABEL[k]}:</b> {ts.map((t) => t.title).join(', ')}. <span>{HIDDEN_SOURCE_HINT[k]}</span></p>{/if}
		{/each}
	</div>
{/if}


<p class="mt-6 max-w-3xl text-xs text-muted-foreground">{HIDDEN_INTRO}</p>
