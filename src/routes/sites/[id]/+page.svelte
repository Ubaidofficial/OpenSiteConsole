<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { LoaderCircle, Plus, Trash2, TrendingDown, TrendingUp } from '@lucide/svelte';
	import Chart from '$lib/components/Chart.svelte';
	import { ConfirmButton } from '$lib/components/ui/confirm';
	import { fmtInt, fmtPct, fmtPos, fmtSigned } from '$lib/format';
	import PlanList from '$lib/components/PlanList.svelte';
	import RankMix from '$lib/components/viz/RankMix.svelte';
	import SegBar from '$lib/components/viz/SegBar.svelte';
	import { POSITION_BUCKETS } from '$lib/plan';

	let { data, form } = $props();
	const markers = $derived([
		...data.annotations.map((a) => ({ date: a.date, label: `${a.title}`, color: a.kind === 'experiment' ? 'var(--c-impr)' : 'var(--warn)' })),
		// Google's ranking updates: the day each one started rolling out
		...data.googleUpdates.map((u) => ({ date: u.begin, label: `Google: ${u.name}`, color: 'var(--c-pos)' }))
	]);
	const today = new Date().toISOString().slice(0, 10);

	// Controlled fields so the date survives a submit (a plain form reset would blank it).
	let date = $state(today);
	let kind = $state('change');
	let title = $state('');
	let prefix = $state('');
	let busy = $state(false);
	let logOpen = $state(false);
	const planMax = $derived(Math.max(0, ...[...data.plan.blocking, ...data.plan.quick, ...data.plan.bigger].map((a) => a.impact ?? 0)) || null);

	const addNote = () => {
		busy = true;
		return async ({ update, result }: { update: (o?: { reset?: boolean }) => Promise<void>; result: { type: string } }) => {
			await update({ reset: false });
			busy = false;
			if (result.type === 'success') {
				title = '';
				prefix = '';
			}
		};
	};
	const dot = (k: string) => (k === 'experiment' ? 'var(--c-impr)' : k === 'migration' ? 'var(--bad)' : k === 'other' ? 'var(--muted-foreground)' : 'var(--warn)');
</script>

<!-- The plan comes first: what to do in the next two weeks, from the ranked findings. The chart and the log follow. -->
<section class="mb-8" aria-labelledby="plan-h">
	<div class="mb-3 flex flex-wrap items-end gap-x-4 gap-y-1">
		<div>
			<h2 id="plan-h" class="text-lg font-semibold tracking-tight">Your next two weeks</h2>
			<p class="text-sm text-muted-foreground">The most valuable things to do on this site now, picked from {data.plan.total} open findings. Tick one off when it is done.</p>
		</div>
		<div class="ml-auto flex gap-2 text-sm">
			<a class="btn !h-8 text-xs" href="/sites/{page.params.id}/quickwins">All quick wins</a>
			<a class="btn !h-8 text-xs" href="/sites/{page.params.id}/actions">All {data.plan.total} findings →</a>
		</div>
	</div>
	{#if data.plan.blocking.length + data.plan.quick.length + data.plan.bigger.length === 0}
		<div class="rounded-xl border border-dashed p-6 text-center text-sm"><p class="font-medium text-good">Nothing to do right now.</p><p class="mt-1 text-muted-foreground">Either the site is in good shape or there is not enough data yet. Connecting GA4, Bing and Clarity widens what is looked at.{#if data.plan.done} {data.plan.done} done item(s) come back if the problem returns.{/if}</p></div>
	{:else}
		<div class="space-y-5">
			{#if data.plan.blocking.length}
				<div><div class="mb-1.5 flex flex-wrap items-baseline gap-x-2"><h3 class="text-sm font-semibold text-bad">Fix first</h3><span class="text-xs text-muted-foreground">These stop the site earning, or stop you measuring it.</span></div><PlanList items={data.plan.blocking} tone="bad" max={planMax} /></div>
			{/if}
			{#if data.plan.quick.length}
				<div><div class="mb-1.5 flex flex-wrap items-baseline gap-x-2"><h3 class="text-sm font-semibold">Quick wins</h3><span class="text-xs text-muted-foreground">Small edits, usually minutes each.</span></div><PlanList items={data.plan.quick} start={data.plan.blocking.length + 1} max={planMax} /></div>
			{/if}
			{#if data.plan.bigger.length}
				<div><div class="mb-1.5 flex flex-wrap items-baseline gap-x-2"><h3 class="text-sm font-semibold">Bigger opportunities</h3><span class="text-xs text-muted-foreground">More work each, for more clicks.</span></div><PlanList items={data.plan.bigger} start={data.plan.blocking.length + data.plan.quick.length + 1} max={planMax} /></div>
			{/if}
		</div>
		<p class="mt-2 text-xs text-muted-foreground">Click estimates come from this site's own click curve. They are model figures, not promises, and are not added up because findings overlap.</p>
	{/if}
</section>

<section class="mb-5 rounded-2xl border bg-card p-5 shadow-xs">
	<div class="mb-3 flex items-baseline justify-between gap-3">
		<h2 class="text-base font-semibold tracking-tight">Traffic</h2>
		<p class="text-xs text-muted-foreground">Shaded bands = unusual days · dots = your change log · dashed end = last 2 days (Google may still revise them)</p>
	</div>
	<Chart data={data.series} {markers} anomalies={data.anomalies} />
	</section>

	<div class="mb-5 grid grid-cols-1 gap-5 lg:grid-cols-3">
	<section class="rounded-2xl border bg-card p-5 shadow-xs lg:col-span-2" aria-labelledby="rank-h">
		<div class="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
			<h2 id="rank-h" class="text-base font-semibold tracking-tight">Where your searches rank</h2>
			<p class="text-xs text-muted-foreground">Searches with at least a few impressions this period, by average position{data.positions.prev ? '; the change is against the previous period' : ''}.</p>
		</div>
		<RankMix now={data.positions.now} prev={data.positions.prev} weeks={data.positions.weeks} hrefFor={(i) => `/sites/${page.params.id}/queries?days=${data.days}&pos=${POSITION_BUCKETS[i].key}`} />
	</section>
	<section class="rounded-2xl border bg-card p-5 shadow-xs" aria-labelledby="brand-h">
		<h2 id="brand-h" class="mb-1 text-base font-semibold tracking-tight">Brand vs non-brand</h2>
		{#if data.brand}
			{@const b = data.brand}
			{@const total = b.now.brand + b.now.other}
			{@const d = b.prev && b.prev.other ? b.now.other / b.prev.other - 1 : null}
			<p class="mb-3 text-xs text-muted-foreground">Non-brand clicks are the ones SEO work moves.</p>
			<div class="flex items-baseline gap-2"><span class="text-2xl font-semibold">{fmtInt(b.now.other)}</span><span class="text-xs text-muted-foreground">non-brand clicks</span>{#if d != null}<span class="tnum text-xs font-medium {d >= 0 ? 'text-good' : 'text-bad'}">{fmtSigned(d)}</span>{/if}</div>
			{#if total}<div class="mt-3"><SegBar title="Clicks from brand and non-brand searches" format={(v) => `${fmtInt(v)} clicks`} parts={[{ label: 'Non-brand', value: b.now.other, color: 'var(--chart-1)' }, { label: 'Brand', value: b.now.brand, color: 'var(--chart-2)' }]} /></div>{/if}
			<p class="mt-2 text-[11px] text-muted-foreground">Brand = contains <span class="pii">{b.terms.join(', ')}</span>. <a class="underline" href="/sites/{page.params.id}/settings">Change</a> · <a class="underline" href="/sites/{page.params.id}/queries?b=nonbrand">See non-brand searches</a></p>
		{:else}
			<p class="text-sm text-muted-foreground">Set your brand terms in <a class="underline" href="/sites/{page.params.id}/settings">Settings</a> to split brand from non-brand clicks.</p>
		{/if}
	</section>
</div>

<div class="grid grid-cols-1 gap-5 lg:grid-cols-2">
	<section>
		<h2 class="mb-2 text-base font-semibold tracking-tight">Anomalies <span class="text-sm font-normal text-muted-foreground">in this period</span></h2>
		<div class="overflow-hidden rounded-xl border bg-card shadow-xs">
			{#each data.anomalies as a}
				<div class="flex items-center gap-3 border-b px-4 py-3 last:border-b-0">
					<span class="grid size-8 place-items-center rounded-lg {a.direction === 'drop' ? 'bg-bad/10 text-bad' : 'bg-good/10 text-good'}">
						{#if a.direction === 'drop'}<TrendingDown class="size-4" />{:else}<TrendingUp class="size-4" />{/if}
					</span>
					<div>
						<div class="text-sm font-medium tnum">{a.date}</div>
						<div class="text-xs text-muted-foreground tnum">{fmtInt(a.value)} clicks vs ~{fmtInt(a.expected)} expected</div>
					</div>
					<span class="ml-auto text-sm font-semibold tnum {a.direction === 'drop' ? 'text-bad' : 'text-good'}">{fmtSigned(a.deltaPct, 0)}</span>
				</div>
			{:else}
				<div class="px-4 py-6 text-center text-sm text-muted-foreground">No unusual days. Traffic is within its normal weekly pattern.</div>
			{/each}
		</div>
		{#if data.anonShare !== null}
			<p class="mt-3 text-xs text-muted-foreground">{fmtPct(data.anonShare, 0)} of clicks come from anonymised queries Google does not list, so query tables will not sum to the totals above.</p>
		{/if}
	</section>

	<section>
		<div class="mb-2 flex items-center gap-2"><h2 class="text-base font-semibold tracking-tight">Change log</h2>
				<details class="group ml-auto" bind:open={logOpen}><summary class="btn !h-8 cursor-pointer list-none text-xs [&::-webkit-details-marker]:hidden"><Plus class="size-3.5" />Log a change</summary></details></div>
				{#if logOpen}
				<form method="POST" action="?/addNote" use:enhance={addNote} class="mb-3 grid gap-3 rounded-xl border bg-card p-4 shadow-xs">
			<div class="grid grid-cols-2 gap-3">
				<label class="grid gap-1.5 text-xs font-medium text-muted-foreground">Date<input class="input w-full text-foreground" type="date" name="date" bind:value={date} required /></label>
				<label class="grid gap-1.5 text-xs font-medium text-muted-foreground">Type
					<select class="input w-full text-foreground" name="kind" bind:value={kind}>
						<option value="change">Change</option>
						<option value="experiment">Experiment</option>
						<option value="migration">Migration</option>
						<option value="other">Other</option>
					</select>
				</label>
			</div>
			<label class="grid gap-1.5 text-xs font-medium text-muted-foreground">What changed?<input class="input w-full text-foreground" name="title" bind:value={title} placeholder="e.g. Rewrote titles on /guides/*" required /></label>
			<label class="grid gap-1.5 text-xs font-medium text-muted-foreground">Measure only this URL prefix <span class="font-normal">(optional)</span><input class="input w-full text-foreground" name="prefix" bind:value={prefix} placeholder="https://example.com/guides/" /></label>
			<div class="flex items-center gap-3">
				<button class="btn btn-primary" disabled={busy || !title.trim()}>{#if busy}<LoaderCircle class="size-4 animate-spin" />Saving…{:else}<Plus class="size-4" />Add to log{/if}</button>
						{#if form?.error}<p class="text-sm text-bad">{form.error}</p>{/if}
					</div>
				</form>
				{/if}

		<div class="space-y-2.5">
			{#each data.annotations as a (a.id)}
				{@const lt = data.annotationTests[a.id]}
				<article class="rounded-xl border bg-card p-4 text-sm shadow-xs">
					<div class="flex items-center gap-2">
						<span class="size-2 rounded-full" style="background:{dot(a.kind)}"></span>
						<span class="text-xs font-medium capitalize">{a.kind}</span>
						<span class="text-xs text-muted-foreground tnum">· {a.date}</span>
						<form method="POST" action="?/deleteNote" use:enhance class="ml-auto">
							<input type="hidden" name="id" value={a.id} />
							<ConfirmButton class="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive" title="Delete this note?" description="It disappears from the chart and the change log. Traffic data is not affected." confirmLabel="Delete note"><Trash2 class="size-3.5" /><span class="sr-only">Delete note</span></ConfirmButton>
						</form>
					</div>
					<div class="mt-1 font-medium">{a.title}</div>
					{#if a.page_prefix}<div class="pii truncate text-xs text-muted-foreground">scope: {a.page_prefix}</div>{/if}
					{#if lt}
						<div class="mt-2 flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-xs">
							<span class="font-medium">Tested:</span>
							<span class="{lt.verdict === 'positive' ? 'text-good' : lt.verdict === 'negative' ? 'text-bad' : 'text-muted-foreground'}">{lt.verdict === 'positive' ? 'likely a real gain' : lt.verdict === 'negative' ? 'likely a real loss' : lt.verdict === 'inconclusive' ? 'no clear effect' : lt.verdict === 'estimate-only' ? 'estimate only' : 'not enough data yet'}{lt.lift != null ? ` (${fmtSigned(lt.lift)} vs control)` : ''}</span>
							{#if lt.verdict === 'inconclusive' && lt.detectable != null && lt.detectable > 0.25}<span class="text-warn">weak evidence: could not detect a change under ±{Math.round(lt.detectable * 100)}%</span>{/if}
							<a class="ml-auto underline" href="/sites/{page.params.id}/tests">details</a>
						</div>
					{:else if a.page_prefix}
						<form method="POST" action="?/makeTest" use:enhance class="mt-2"><input type="hidden" name="id" value={a.id} /><button class="btn !h-7 text-xs">Test this change properly</button></form>
					{/if}
					{#if a.result.tooEarly}
						<div class="mt-2 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">Too early to judge: {a.result.afterDays} day(s) of data since the change (7+ needed).</div>
					{:else}
						<div class="mt-2 grid grid-cols-3 gap-2 rounded-lg bg-muted/60 px-3 py-2 text-xs tnum">
							<div><div class="text-muted-foreground">Clicks/day</div><div class="font-medium">{fmtInt(a.result.clicksBefore)} → {fmtInt(a.result.clicksAfter)}</div></div>
							<div><div class="text-muted-foreground">vs site trend</div><div class="font-semibold {(a.result.lift ?? 0) >= 0 ? 'text-good' : 'text-bad'}">{fmtSigned(a.result.lift)}</div><div class="text-muted-foreground">{fmtSigned(a.result.rawChange)} raw</div></div>
							<div><div class="text-muted-foreground">Position</div><div class="font-medium">{fmtPos(a.result.posBefore)} → {fmtPos(a.result.posAfter)}</div></div>
						</div>
						<div class="mt-1.5 text-[11px] text-muted-foreground">{a.result.afterDays}d after vs 28d before. A rough readout with no significance test{lt ? '; see the verdict above' : a.page_prefix ? '; use “Test this change properly” for a verdict' : ''}.</div>
					{/if}
				</article>
			{:else}
				<p class="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">Log title rewrites, redirects or launches here. After 7+ days you get a before/after readout adjusted for the site's overall trend.</p>
			{/each}
		</div>
	</section>
</div>
