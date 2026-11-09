<script lang="ts">
	/** A chart the chat drew: lines on one shared scale (LineChart), or grouped bars. Values come from the model's own tool results. */
	import LineChart from './LineChart.svelte';
	import type { ChartSpec } from '$lib/chat';

	let { chart }: { chart: ChartSpec } = $props();
	const COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--warn)'];
	const fmt = (v: number) => (Math.abs(v) >= 1_000_000 ? `${(v / 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 1 })}M` : Math.abs(v) >= 1000 ? `${(v / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })}k` : v.toLocaleString('en-US', { maximumFractionDigits: 2 }));

	let width = $state(640);
	let hover = $state<number | null>(null);
	const height = 240;
	const pad = { l: 44, r: 8, t: 10, b: 30 };
	const innerW = $derived(Math.max(10, width - pad.l - pad.r));
	const innerH = height - pad.t - pad.b;
	const max = $derived(Math.max(1, ...chart.series.flatMap((s) => s.values)));
	const min = $derived(Math.min(0, ...chart.series.flatMap((s) => s.values)));
	const y = (v: number) => pad.t + (1 - (v - min) / (max - min)) * innerH;
	const slot = $derived(innerW / chart.labels.length);
	const barW = $derived(Math.max(2, Math.min(36, (slot * 0.72) / chart.series.length)));
	const ticks = $derived([0, 0.5, 1].map((t) => min + (max - min) * t));
	// Show every label when they fit, else every n-th.
	const every = $derived(Math.max(1, Math.ceil(chart.labels.length / Math.max(1, Math.floor(innerW / 64)))));
</script>

<figure class="rounded-xl border bg-card p-4">
	<figcaption class="mb-3 flex items-baseline justify-between gap-3">
		<span class="text-sm font-semibold">{chart.title}</span>
		{#if chart.y_label}<span class="text-xs text-muted-foreground">{chart.y_label}</span>{/if}
	</figcaption>
	{#if chart.type === 'line'}
		<LineChart xs={chart.labels} series={chart.series.map((s, i) => ({ label: s.name, color: COLORS[i % COLORS.length], values: s.values }))} format={fmt} zero={min >= 0} height={220} />
	{:else}
		<div class="relative" bind:clientWidth={width}>
			{#if chart.series.length > 1}
				<div class="mb-2 flex flex-wrap gap-3 text-xs">
					{#each chart.series as s, i}<span class="inline-flex items-center gap-1.5"><span class="inline-block size-2.5 rounded-sm" style="background:{COLORS[i % COLORS.length]}"></span>{s.name}</span>{/each}
				</div>
			{/if}
			<svg {width} {height} role="img" aria-label={chart.title} class="touch-none select-none" onpointerleave={() => (hover = null)}>
				{#each ticks as t}
					<line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} stroke="var(--border)" />
					<text x={pad.l - 6} y={y(t) + 3.5} text-anchor="end" font-size="10" fill="var(--muted-foreground)">{fmt(t)}</text>
				{/each}
				{#each chart.labels as label, i}
					<rect x={pad.l + i * slot} y={pad.t} width={slot} height={innerH} fill={hover === i ? 'var(--accent)' : 'transparent'} role="presentation" onpointerenter={() => (hover = i)} />
					{#each chart.series as s, k}
						{@const v = s.values[i]}
						<rect x={pad.l + i * slot + (slot - barW * chart.series.length) / 2 + k * barW} y={Math.min(y(v), y(0))} width={Math.max(1, barW - 2)} height={Math.max(1, Math.abs(y(v) - y(0)))} rx="2" fill={COLORS[k % COLORS.length]} class="pointer-events-none" />
					{/each}
					{#if i % every === 0}<text x={pad.l + i * slot + slot / 2} y={height - 10} text-anchor="middle" font-size="10" fill="var(--muted-foreground)">{label.length > 12 ? label.slice(0, 11) + '…' : label}</text>{/if}
				{/each}
			</svg>
			{#if hover !== null}
				<div class="pointer-events-none absolute top-6 rounded-md border bg-card px-2 py-1 text-xs shadow-sm" style="left:{Math.min(Math.max(pad.l + hover * slot - 40, 4), width - 180)}px">
					<div class="font-medium">{chart.labels[hover]}</div>
					{#each chart.series as s, k}<div><span style="color:{COLORS[k % COLORS.length]}">●</span> {s.name}: {s.values[hover].toLocaleString('en-US')}</div>{/each}
				</div>
			{/if}
		</div>
	{/if}
</figure>
