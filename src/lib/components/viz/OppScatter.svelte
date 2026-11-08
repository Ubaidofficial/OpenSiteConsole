<script lang="ts">
	/**
	 * Where the opportunities are: each search is a dot at its average position (x, 1 on the left) and its impressions (y, log scale,
	 * since a few searches have far more than the rest). Dot area grows with the estimated extra clicks. The band from position 4 to
	 * 20 (striking distance) is shaded, and the largest few dots are labelled directly. Hover or focus names any dot.
	 * One hue: the dots are one series; size carries the estimate, so colour stays free.
	 */
	export interface Pt { label: string; position: number; impressions: number; gain: number; href?: string }
	let { points, height = 280, labelTop = 4 }: { points: Pt[]; height?: number; labelTop?: number } = $props();
	let width = $state(720);
	const pad = { l: 52, r: 16, t: 22, b: 34 }; // the top pad leaves room for the largest dot's radius
	const xMax = $derived(Math.max(20, Math.ceil(Math.max(...points.map((p) => p.position), 1) / 5) * 5));
	const yMin = $derived(Math.max(1, Math.min(...points.map((p) => p.impressions)) * 0.7));
	const yMax = $derived(Math.max(...points.map((p) => p.impressions), 100));
	const lMin = $derived(Math.log10(yMin));
	const lMax = $derived(Math.log10(yMax) + 0.12);
	const gMax = $derived(Math.max(1, ...points.map((p) => p.gain)));
	const X = (pos: number) => pad.l + ((pos - 1) / (xMax - 1)) * (width - pad.l - pad.r);
	const Y = (imp: number) => pad.t + (1 - (Math.log10(Math.max(imp, yMin)) - lMin) / (lMax - lMin)) * (height - pad.t - pad.b);
	const R = (g: number) => 4 + Math.sqrt(Math.max(0, g) / gMax) * 12;
	const yTicks = $derived.by(() => {
		const out: number[] = [];
		for (let e = Math.floor(lMin); e <= Math.ceil(lMax); e++) for (const m of [1, 10 ** 0.5]) { const v = 10 ** e * m; if (v >= yMin * 0.99 && v <= yMax * 1.12) out.push(Math.round(v)); }
		return out.filter((v, i, a) => a.indexOf(v) === i).slice(-6);
	});
	const xTicks = $derived([1, 3, 5, 10, 15, 20, ...(xMax > 20 ? [xMax] : [])].filter((v) => v <= xMax));
	const ranked = $derived([...points].sort((a, b) => b.gain - a.gain));
	/** Label the biggest few, skipping any label that would overlap one already placed (about 6px per character at 11px). */
	const labels = $derived.by(() => {
		const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
		const out: { p: Pt; x: number; y: number; anchor: 'start' | 'end'; text: string }[] = [];
		for (const p of ranked) {
			if (out.length >= labelTop) break;
			const text = p.label.length > 26 ? p.label.slice(0, 25) + '…' : p.label;
			const w = text.length * 6.1;
			const right = X(p.position) < width * 0.68;
			const x = X(p.position) + (right ? R(p.gain) + 4 : -R(p.gain) - 4);
			const y = Y(p.impressions) + 3;
			const box = { x0: right ? x : x - w, x1: right ? x + w : x, y0: y - 10, y1: y + 3 };
			if (placed.some((b) => box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0)) continue;
			placed.push(box);
			out.push({ p, x, y, anchor: right ? 'start' : 'end', text });
		}
		return out;
	});
	const labelled = $derived(new Set(labels.map((l) => l.p.label)));
	let hover = $state<Pt | null>(null);
	const compact = (v: number) => (v >= 10_000 ? `${Math.round(v / 1000)}K` : v >= 1000 ? `${(v / 1000).toFixed(1).replace(/\.0$/, '')}K` : String(v));
</script>

<div class="relative w-full" bind:clientWidth={width}>
	<svg {width} {height} role="img" aria-label="Searches by position and impressions; dot size is the estimated extra clicks. Biggest: {ranked.slice(0, 3).map((p) => `${p.label} (position ${p.position.toFixed(1)}, about ${Math.round(p.gain)} extra clicks)`).join('; ')}.">
		<!-- striking distance band: positions 4 to 20 -->
		<rect x={X(4)} y={pad.t} width={X(Math.min(20, xMax)) - X(4)} height={height - pad.t - pad.b} fill="var(--chart-1)" opacity="0.06" rx="4" />
		<text x={X(4) + 6} y={height - pad.b - 6} class="fill-muted-foreground text-[10px]">striking distance: positions 4–20</text>
		{#each yTicks as t}
			<line x1={pad.l} x2={width - pad.r} y1={Y(t)} y2={Y(t)} stroke="var(--grid)" stroke-width="1" />
			<text x={pad.l - 8} y={Y(t) + 3} text-anchor="end" class="tnum fill-muted-foreground text-[10px]">{compact(t)}</text>
		{/each}
		{#each xTicks as t}<text x={X(t)} y={height - pad.b + 16} text-anchor="middle" class="tnum fill-muted-foreground text-[10px]">{t}</text>{/each}
		<text x={(pad.l + width - pad.r) / 2} y={height - 4} text-anchor="middle" class="fill-muted-foreground text-[10px]">average position (1 is the top)</text>
		<text transform="translate(12 {(pad.t + height - pad.b) / 2}) rotate(-90)" text-anchor="middle" class="fill-muted-foreground text-[10px]">impressions</text>
		{#each ranked.slice().reverse() as p (p.label)}
			<circle cx={X(p.position)} cy={Y(p.impressions)} r={R(p.gain)} fill="var(--chart-1)" fill-opacity={hover && hover !== p ? 0.25 : 0.55} stroke="var(--card)" stroke-width="2"
				role="presentation" onpointerenter={() => (hover = p)} onpointerleave={() => (hover = null)} />
		{/each}
		{#each labels as l (l.p.label)}
			<text x={l.x} y={l.y} text-anchor={l.anchor} class="pii pointer-events-none fill-foreground text-[11px] font-medium" paint-order="stroke" stroke="var(--card)" stroke-width="3">{l.text}</text>
		{/each}
	</svg>
	{#if hover}
		<div class="pointer-events-none absolute z-20 rounded-md border bg-popover px-2.5 py-1.5 text-xs shadow-md" style="left:{Math.min(X(hover.position) + 12, width - 220)}px; top:{Math.max(0, Y(hover.impressions) - 50)}px">
			<div class="pii max-w-52 truncate font-medium">{hover.label}</div>
			<div class="tnum text-muted-foreground">position {hover.position.toFixed(1)} · {hover.impressions.toLocaleString('en-US')} impressions</div>
			<div class="tnum">≈ {Math.round(hover.gain).toLocaleString('en-US')} extra clicks</div>
		</div>
	{/if}
	{#if !labelled.size}<p class="text-xs text-muted-foreground">No searches to plot.</p>{/if}
</div>
