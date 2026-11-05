<script lang="ts">
	import { enhance } from '$app/forms';
	import Chart from '$lib/components/Chart.svelte';
	import { fmtInt, fmtPct, fmtPos, fmtSigned } from '$lib/format';

	let { data, form } = $props();
	const markers = $derived(data.annotations.map((a) => ({ date: a.date, label: `${a.title}`, color: a.kind === 'experiment' ? 'var(--c-impr)' : 'var(--warn)' })));
	const today = new Date().toISOString().slice(0, 10);
</script>

<div class="card mb-4 p-4">
	<Chart data={data.series} {markers} anomalies={data.anomalies} />
	<p class="mt-2 text-xs text-muted">Shaded bands = anomalies (day-of-week adjusted). Dots = your change log.</p>
</div>

<div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
	<section>
		<h2 class="mb-2 font-medium">Anomalies <span class="font-normal text-muted">in this period</span></h2>
		<div class="card">
			{#each data.anomalies as a}
				<div class="td flex items-center gap-3 !border-b-0 border-t" style="border-color:var(--line)">
					<span class="tnum w-24">{a.date}</span>
					<span class={a.direction === 'drop' ? 'text-bad' : 'text-good'}>{a.direction === 'drop' ? '▼' : '▲'} {fmtSigned(a.deltaPct, 0)}</span>
					<span class="tnum ml-auto text-xs text-muted">{fmtInt(a.value)} clicks vs ~{fmtInt(a.expected)} expected</span>
				</div>
			{:else}
				<div class="p-3 text-muted">No unusual days. Traffic is within its normal weekly pattern.</div>
			{/each}
		</div>
		{#if data.anonShare !== null}
			<p class="mt-3 text-xs text-muted">
				{fmtPct(data.anonShare, 0)} of clicks come from anonymised queries Google does not list, so query tables will not sum to the totals above.
			</p>
		{/if}
	</section>

	<section>
		<h2 class="mb-2 font-medium">Change log &amp; experiments</h2>
		<form method="POST" action="?/addNote" use:enhance class="card mb-3 grid grid-cols-6 gap-2 p-3">
			<input class="input col-span-2" type="date" name="date" value={today} required />
			<select class="input col-span-2" name="kind">
				<option value="change">Change</option>
				<option value="experiment">Experiment</option>
				<option value="migration">Migration</option>
				<option value="other">Other</option>
			</select>
			<button class="btn btn-primary col-span-2 justify-center">Add</button>
			<input class="input col-span-6" name="title" placeholder="What changed? e.g. Rewrote titles on /guides/*" required />
			<input class="input col-span-6" name="prefix" placeholder="Optional URL prefix to measure, e.g. https://example.com/guides/" />
		</form>
		{#if form?.error}<p class="mb-2 text-sm text-bad">{form.error}</p>{/if}
		<div class="space-y-2">
			{#each data.annotations as a (a.id)}
				<div class="card p-3 text-sm">
					<div class="flex items-center gap-2">
						<span class="tnum text-muted">{a.date}</span><span class="chip">{a.kind}</span>
						<form method="POST" action="?/deleteNote" use:enhance class="ml-auto"><input type="hidden" name="id" value={a.id} /><button class="text-xs text-muted hover:text-[color:var(--bad)]" aria-label="Delete note">✕</button></form>
					</div>
					<div class="font-medium">{a.title}</div>
					{#if a.page_prefix}<div class="truncate text-xs text-muted">scope: {a.page_prefix}</div>{/if}
					{#if a.result.tooEarly}
						<div class="mt-1 text-xs text-muted">Too early to judge — {a.result.afterDays} day(s) of data since the change (need 7+).</div>
					{:else}
						<div class="tnum mt-1 text-xs">
							Clicks/day {fmtInt(a.result.clicksBefore)} → {fmtInt(a.result.clicksAfter)}
							(<span>{fmtSigned(a.result.rawChange)}</span> raw, <b class={(a.result.lift ?? 0) >= 0 ? 'text-good' : 'text-bad'}>{fmtSigned(a.result.lift)}</b> vs site trend)
							· pos {fmtPos(a.result.posBefore)} → {fmtPos(a.result.posAfter)}
							<span class="text-muted">· {a.result.afterDays}d after vs 28d before</span>
						</div>
					{/if}
				</div>
			{:else}
				<p class="text-muted">Log title rewrites, redirects or launches here. After 7+ days you get a before/after readout adjusted for the site's overall trend.</p>
			{/each}
		</div>
	</section>
</div>
