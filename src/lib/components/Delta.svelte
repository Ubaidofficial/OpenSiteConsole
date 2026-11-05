<script lang="ts">
	import { fmtSigned } from '$lib/format';
	/** value is a fraction (0.12 = +12%). invert: for metrics where lower is better (position). */
	let { value, invert = false }: { value: number | null; invert?: boolean } = $props();
	const good = $derived(value == null || Math.abs(value) < 0.005 ? null : invert ? value < 0 : value > 0);
</script>

<span class="tnum text-xs" class:text-good={good === true} class:text-bad={good === false} class:text-muted={good === null}>{fmtSigned(value)}</span>
