<script lang="ts">
	/**
	 * Is the click rate normal for the position? The line is this site's own click-through rate at positions 1 to 10 (filled marker =
	 * measured on this site, hollow = a fallback benchmark). Optional points are searches plotted at their own position and click rate:
	 * the ones well below the line are the title-and-snippet fixes. Two series, both labelled in the legend; one shared y axis.
	 */
	export interface P { label: string; position: number; ctr: number }
	let { values, fitted, points = [], height = 220 }: { values: number[]; fitted: boolean[]; points?: P[]; height?: number } = $props();
	let width = $state(640);
	const pad = { l: 44, r: 14, t: 12, b: 32 };
	const n = $derived(values.length);
	const yMax = $derived(Math.max(0.05, ...values, ...points.filter((p) => p.position <= n + 0.5).map((p) => p.ctr)) * 1.1);
	const X = (pos: number) => pad.l + ((pos - 1) / Math.max(1, n - 1)) * (width - pad.l - pad.r);
	const Y = (v: number) => pad.t + (1 - v / yMax) * (height - pad.t - pad.b);
	const ticks = $derived([0, 0.25, 0.5, 0.75, 1].map((f) => f * yMax).map((v) => Math.round(v * 100) / 100).filter((v, i, a) => a.indexOf(v) === i));
	const line = $derived(values.map((v, i) => `${i ? 'L' : 'M'}${X(i + 1).toFixed(1)},${Y(v).toFixed(1)}`).join(''));
	const pts = $derived(points.filter((p) => p.position >= 1 && p.position <= n));
	let hover = $state<{ x: number; y: number; text: string } | null>(null);
	const pct = (v: number) => `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`;
</script>

<div class="relative w-full" bind:clientWidth={width}>
	<div class="mb-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-hidden="true">
		<span class="inline-flex items-center gap-1.5"><span class="h-0.5 w-4 rounded" style="background:var(--chart-1)"></span>your click rate by position</span>
		{#if pts.length}<span class="inline-flex items-center gap-1.5"><span class="size-2 rounded-full" style="background:var(--chart-2)"></span>searches far below it</span>{/if}
		<span class="inline-flex items-center gap-1.5"><span class="size-2 rounded-full border" style="border-color:var(--chart-1)"></span>hollow = fallback, not enough data</span>
	</div>
	<svg {width} {height} role="img" aria-label="Click-through rate by position: {values.map((v, i) => `#${i + 1} ${pct(v)}`).join(', ')}.{pts.length ? ` ${pts.length} searches sit well below it.` : ''}">
		{#each ticks as t}
			<line x1={pad.l} x2={width - pad.r} y1={Y(t)} y2={Y(t)} stroke="var(--grid)" stroke-width="1" />
			<text x={pad.l - 8} y={Y(t) + 3} text-anchor="end" class="tnum fill-muted-foreground text-[10px]">{pct(t)}</text>
		{/each}
		{#each values as _, i}<text x={X(i + 1)} y={height - pad.b + 16} text-anchor="middle" class="tnum fill-muted-foreground text-[10px]">#{i + 1}</text>{/each}
		<text x={(pad.l + width - pad.r) / 2} y={height - 3} text-anchor="middle" class="fill-muted-foreground text-[10px]">position</text>
		<path d={line} fill="none" stroke="var(--chart-1)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
		{#each pts as p}
			<circle cx={X(p.position)} cy={Y(p.ctr)} r="4.5" fill="var(--chart-2)" stroke="var(--card)" stroke-width="2" role="presentation"
				onpointerenter={() => (hover = { x: X(p.position), y: Y(p.ctr), text: `${p.label}: ${pct(p.ctr)} at position ${p.position.toFixed(1)}` })} onpointerleave={() => (hover = null)} />
		{/each}
		{#each values as v, i}
			<circle cx={X(i + 1)} cy={Y(v)} r="4.5" fill={fitted[i] ? 'var(--chart-1)' : 'var(--card)'} stroke={fitted[i] ? 'var(--card)' : 'var(--chart-1)'} stroke-width="2" role="presentation"
				onpointerenter={() => (hover = { x: X(i + 1), y: Y(v), text: `Position ${i + 1}: ${pct(v)} ${fitted[i] ? '(measured on this site)' : '(fallback benchmark)'}` })} onpointerleave={() => (hover = null)} />
		{/each}
		<!-- label the top of the curve once, so the scale reads without hovering -->
		<text x={X(1) + 8} y={Y(values[0] ?? 0) + 4} class="tnum fill-foreground text-[11px] font-medium" paint-order="stroke" stroke="var(--card)" stroke-width="3">{pct(values[0] ?? 0)} at #1</text>
	</svg>
	{#if hover}<div class="pii pointer-events-none absolute z-20 max-w-64 rounded-md border bg-popover px-2.5 py-1.5 text-xs shadow-md" style="left:{Math.min(hover.x + 10, width - 260)}px; top:{Math.max(0, hover.y + 4)}px">{hover.text}</div>{/if}
</div>
