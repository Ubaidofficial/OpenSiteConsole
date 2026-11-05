<script lang="ts">
	import type { Trend } from '$lib/trend';
	/**
	 * Filled area chart for a card, coloured by trend (green = growing, red = falling, grey = flat).
	 * The last `dashed` points are drawn dashed: Search Console revises the most recent days.
	 */
	let { values, trend = 'flat', dashed = 2, height = 84, class: className = '' }: { values: number[]; trend?: Trend; dashed?: number; height?: number; class?: string } = $props();
	const uid = $props.id();
	const W = 300;
	const geom = $derived.by(() => {
		const n = values.length;
		const H = height;
		const max = Math.max(1, ...values);
		const pts = values.map((v, i) => [n < 2 ? W / 2 : (i / (n - 1)) * W, H - 3 - (v / max) * (H - 12)] as const);
		const d = (a: readonly (readonly [number, number])[]) => a.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
		const cut = Math.max(1, n - dashed);
		return {
			H,
			line: d(pts.slice(0, cut + 1)),
			tail: n > 1 ? d(pts.slice(cut)) : '',
			area: n > 1 ? `${d(pts)}L${W},${H}L0,${H}Z` : ''
		};
	});
	const color = $derived(trend === 'up' ? 'var(--trend-up)' : trend === 'down' ? 'var(--trend-down)' : 'color-mix(in oklab, var(--foreground) 55%, transparent)');
</script>

<svg
	viewBox="0 0 {W} {geom.H}"
	preserveAspectRatio="none"
	class="block w-full overflow-visible {className}"
	style="height:{height}px;color:{color}"
	role="img"
	aria-label={trend === 'up' ? 'Daily clicks, growing' : trend === 'down' ? 'Daily clicks, falling' : 'Daily clicks'}
>
	<defs>
		<linearGradient id="fill-{uid}" x1="0" y1="0" x2="0" y2="1">
			<stop offset="0%" stop-color="currentColor" stop-opacity="0.28" />
			<stop offset="100%" stop-color="currentColor" stop-opacity="0" />
		</linearGradient>
	</defs>
	{#if geom.area}
		<path d={geom.area} fill="url(#fill-{uid})" />
		<path d={geom.line} fill="none" stroke="currentColor" stroke-width="2.25" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" style="filter:drop-shadow(0 2px 5px color-mix(in oklab, currentColor 45%, transparent))" />
		<path d={geom.tail} fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="3 4" stroke-linecap="round" vector-effect="non-scaling-stroke" opacity="0.75" />
	{:else}
		<line x1="0" x2={W} y1={geom.H - 3} y2={geom.H - 3} stroke="currentColor" stroke-opacity="0.35" vector-effect="non-scaling-stroke" />
	{/if}
</svg>
