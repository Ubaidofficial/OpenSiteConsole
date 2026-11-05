<script lang="ts">
	/**
	 * Lines on ONE shared y-scale (unlike Chart, which scales each series to its own range). Use it when series are
	 * compared with each other: test vs control, history vs projection. `null` leaves a gap.
	 */
	interface S { label: string; color: string; values: (number | null)[]; dashed?: boolean; lo?: (number | null)[]; hi?: (number | null)[] }
	let {
		xs,
		series,
		marker = null,
		height = 240,
		zero = true,
		baseline = null,
		format = (v: number) => String(Math.round(v))
	}: {
		xs: string[];
		series: S[];
		marker?: { x: string; label: string } | null;
		height?: number;
		/** start the y axis at 0 */
		zero?: boolean;
		/** a horizontal reference line, e.g. 100 for an index */
		baseline?: number | null;
		format?: (v: number) => string;
	} = $props();

	let width = $state(800);
	let hover = $state<number | null>(null);
	const pad = { l: 44, r: 12, t: 12, b: 24 };
	const innerW = $derived(Math.max(10, width - pad.l - pad.r));
	const innerH = $derived(height - pad.t - pad.b);
	const x = (i: number) => pad.l + (xs.length <= 1 ? innerW / 2 : (i / (xs.length - 1)) * innerW);

	const range = $derived.by(() => {
		const all = series.flatMap((s) => [...s.values, ...(s.lo ?? []), ...(s.hi ?? [])]).filter((v): v is number => v != null && Number.isFinite(v));
		if (baseline != null) all.push(baseline);
		let lo = zero ? 0 : Math.min(...all, 0);
		if (!zero && all.length) lo = Math.min(...all);
		let hi = Math.max(1, ...all);
		if (hi === lo) hi = lo + 1;
		return { lo, hi };
	});
	const y = (v: number) => pad.t + (1 - (v - range.lo) / (range.hi - range.lo)) * innerH;
	const path = (vals: (number | null)[]) => {
		let d = '';
		let pen = false;
		vals.forEach((v, i) => {
			if (v == null) return void (pen = false);
			d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
			pen = true;
		});
		return d;
	};
	const band = (s: S) => {
		if (!s.lo || !s.hi) return '';
		const idx = s.lo.map((_, i) => i).filter((i) => s.lo![i] != null && s.hi![i] != null);
		if (idx.length < 2) return '';
		return idx.map((i, k) => `${k ? 'L' : 'M'}${x(i).toFixed(1)},${y(s.hi![i]!).toFixed(1)}`).join('') + [...idx].reverse().map((i) => `L${x(i).toFixed(1)},${y(s.lo![i]!).toFixed(1)}`).join('') + 'Z';
	};
	const yTicks = $derived([0, 0.25, 0.5, 0.75, 1].map((t) => ({ v: range.lo + (range.hi - range.lo) * t, y: y(range.lo + (range.hi - range.lo) * t) })));
	const xTicks = $derived(xs.length ? [...new Set([0, 0.25, 0.5, 0.75, 1].map((t) => Math.round(t * (xs.length - 1))))] : []);
	const fmtDay = (d: string) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : d);
	const mIdx = $derived(marker ? xs.indexOf(marker.x) : -1);
	function move(e: PointerEvent) {
		const r = (e.currentTarget as SVGElement).getBoundingClientRect();
		hover = Math.min(xs.length - 1, Math.max(0, Math.round(((e.clientX - r.left - pad.l) / innerW) * (xs.length - 1))));
	}
</script>

<div class="relative" bind:clientWidth={width}>
	<div class="mb-2 flex flex-wrap gap-3 text-xs">
		{#each series as s}
			<span class="inline-flex items-center gap-1.5"><span class="inline-block h-0.5 w-4" style="background:{s.color};{s.dashed ? 'background:repeating-linear-gradient(90deg,' + s.color + ' 0 4px,transparent 4px 7px)' : ''}"></span>{s.label}</span>
		{/each}
	</div>
	{#if xs.length < 2}
		<div class="flex items-center justify-center text-muted-foreground" style="height:{height}px">Not enough data yet</div>
	{:else}
		<svg {width} {height} role="img" aria-label="Comparison chart" onpointermove={move} onpointerleave={() => (hover = null)} class="touch-none select-none">
			{#each yTicks as t}
				<line x1={pad.l} x2={width - pad.r} y1={t.y} y2={t.y} stroke="var(--border)" stroke-width="1" />
				<text x={pad.l - 6} y={t.y + 3.5} text-anchor="end" font-size="10" fill="var(--muted-foreground)">{format(t.v)}</text>
			{/each}
			{#each xTicks as i}<text x={x(i)} y={height - 6} text-anchor={i === 0 ? 'start' : i === xs.length - 1 ? 'end' : 'middle'} font-size="10" fill="var(--muted-foreground)">{fmtDay(xs[i])}</text>{/each}
			{#if baseline != null}<line x1={pad.l} x2={width - pad.r} y1={y(baseline)} y2={y(baseline)} stroke="var(--muted-foreground)" stroke-dasharray="2 4" stroke-width="1" />{/if}
			{#each series as s}{#if band(s)}<path d={band(s)} fill={s.color} opacity="0.14" />{/if}{/each}
			{#each series as s}<path d={path(s.values)} fill="none" stroke={s.color} stroke-width="2" stroke-dasharray={s.dashed ? '5 4' : undefined} stroke-linejoin="round" />{/each}
			{#if mIdx >= 0 && marker}
				<line x1={x(mIdx)} x2={x(mIdx)} y1={pad.t} y2={pad.t + innerH} stroke="var(--warn)" stroke-dasharray="3 3" />
				<text x={x(mIdx) + 4} y={pad.t + 10} font-size="10" fill="var(--warn)">{marker.label}</text>
			{/if}
			{#if hover !== null}
				<line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + innerH} stroke="var(--muted-foreground)" stroke-opacity="0.4" />
				{#each series as s}{#if s.values[hover] != null}<circle cx={x(hover)} cy={y(s.values[hover]!)} r="3.5" fill={s.color} />{/if}{/each}
			{/if}
		</svg>
		{#if hover !== null}
			<div class="pointer-events-none absolute top-8 rounded-md border bg-card px-2 py-1 text-xs shadow-sm" style="left:{Math.min(Math.max(x(hover) - 70, 4), width - 170)}px">
				<div class="font-medium">{fmtDay(xs[hover])}</div>
				{#each series as s}{#if s.values[hover] != null}<div><span style="color:{s.color}">●</span> {s.label}: {format(s.values[hover]!)}</div>{/if}{/each}
			</div>
		{/if}
	{/if}
</div>
