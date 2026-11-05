<script lang="ts">
	/**
	 * Filled area chart for a card. The last `dashed` points are drawn dashed: Search Console revises the
	 * most recent days, so they are provisional.
	 */
	let { values, dashed = 2, height = 84, class: className = '' }: { values: number[]; dashed?: number; height?: number; class?: string } = $props();
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
</script>

<svg viewBox="0 0 {W} {geom.H}" preserveAspectRatio="none" class="block w-full text-foreground/80 {className}" style="height:{height}px" role="img" aria-label="Daily clicks">
	{#if geom.area}
		<path d={geom.area} fill="currentColor" fill-opacity="0.07" />
		<path d={geom.line} fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />
		<path d={geom.tail} fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="3 3" stroke-linecap="round" vector-effect="non-scaling-stroke" opacity="0.7" />
	{:else}
		<line x1="0" x2={W} y1={geom.H - 3} y2={geom.H - 3} stroke="currentColor" stroke-opacity="0.3" vector-effect="non-scaling-stroke" />
	{/if}
</svg>
