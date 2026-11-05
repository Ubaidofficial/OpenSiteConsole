<script lang="ts">
	import { fmtPct } from '$lib/format';
	import { fmtVital, type Rating } from '$lib/vitals';
	import { privacy } from '$lib/privacy.svelte';

	let { data } = $props();
	const tone: Record<Rating, string> = { good: 'text-good', 'needs-improvement': 'text-warn', poor: 'text-bad' };
	const word: Record<Rating, string> = { good: 'Good', 'needs-improvement': 'Needs improvement', poor: 'Poor' };
	const bar: Record<Rating, string> = { good: 'bg-[color:var(--good)]', 'needs-improvement': 'bg-[color:var(--warn)]', poor: 'bg-[color:var(--bad)]' };
	const anyData = $derived(data.devices.some((d) => d.has));
</script>

{#if !data.connected}
	<div class="card p-6 text-center">
		<p class="mb-3">Core Web Vitals are not connected.</p>
		<p class="mb-4 text-sm text-muted-foreground">Real-user speed data from Google's Chrome UX Report. It needs a free API key and takes a minute to set up.</p>
		<a class="btn btn-primary" href="/connect">Connect Core Web Vitals</a>
	</div>
{:else if !anyData}
	<div class="card p-6 text-sm text-muted-foreground">
		No Core Web Vitals data for this site yet. Chrome only reports a site once it has enough real visits, so small or new sites often have none. If the site should have enough traffic, press <b>Sync</b>; the data is also fetched once a day.
	</div>
{:else}
	<p class="mb-3 text-sm text-muted-foreground">
		Real Chrome users over the last 28 days (75th percentile, as Google judges them), from the Chrome UX Report. It is field data for the whole site, not for one page, and it is not the same as a lab test.
		{#if data.snapshots}History builds up from the day you connected: {data.snapshots} daily snapshot{data.snapshots === 1 ? '' : 's'} so far.{/if}
	</p>
	<div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
		{#each data.devices as d (d.formFactor)}
			<div class="rounded-2xl border bg-card p-5 shadow-xs">
				<div class="mb-1 flex items-baseline justify-between gap-3">
					<h2 class="text-lg font-semibold tracking-tight">{d.formFactor === 'PHONE' ? 'Phone' : 'Desktop'}</h2>
					{#if d.has}<span class="text-xs text-muted-foreground">snapshot {d.date}</span>{/if}
				</div>
				{#if !d.has}
					<p class="text-sm text-muted-foreground">Not enough {d.formFactor === 'PHONE' ? 'phone' : 'desktop'} traffic for Chrome to report.</p>
				{:else}
					<p class="mb-3 text-xs text-muted-foreground"><span class="pii">{d.origin}</span></p>
					<div class="space-y-3">
						{#each d.metrics.filter((m) => m.value != null) as m (m.key)}
							<div>
								<div class="flex items-baseline justify-between gap-3">
									<span class="text-sm" title={m.long}><b class="font-semibold">{m.name}</b> <span class="text-xs text-muted-foreground">{m.long}{m.core ? '' : ' (supporting)'}</span></span>
									<span class="tnum text-lg font-semibold {m.rating ? tone[m.rating] : ''}">{fmtVital(m.key, m.value)}</span>
								</div>
								<div class="flex items-center justify-between text-[11px] text-muted-foreground">
									<span>{m.rating ? word[m.rating] : ''} · good ≤ {fmtVital(m.key, m.good)}, poor > {fmtVital(m.key, m.poor)}</span>
									{#if m.goodShare != null}<span>{fmtPct(m.goodShare, 0)} of loads good</span>{/if}
								</div>
								{#if m.goodShare != null}
									<div class="mt-1 h-1.5 overflow-hidden rounded-full bg-muted"><div class="h-full rounded-full {m.rating ? bar[m.rating] : 'bg-foreground/60'}" style="width:{Math.max(2, m.goodShare * 100)}%"></div></div>
								{/if}
							</div>
						{/each}
					</div>
				{/if}
			</div>
		{/each}
	</div>
{/if}
