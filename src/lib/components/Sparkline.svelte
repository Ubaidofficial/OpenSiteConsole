<script lang="ts">
	let { values, width = 120, height = 32, color = 'var(--c-clicks)' }: { values: number[]; width?: number; height?: number; color?: string } = $props();
	const d = $derived.by(() => {
		if (values.length < 2) return '';
		const max = Math.max(1, ...values);
		return values.map((v, i) => `${i ? 'L' : 'M'}${((i / (values.length - 1)) * (width - 2) + 1).toFixed(1)},${(height - 2 - (v / max) * (height - 4)).toFixed(1)}`).join('');
	});
</script>

<svg {width} {height} aria-hidden="true">
	{#if d}<path {d} fill="none" stroke={color} stroke-width="1.5" stroke-linejoin="round" />{/if}
</svg>
