<script lang="ts">
	import { fmtSigned } from '$lib/format';
	/**
	 * pct: value is a fraction (0.12 = +12%).
	 * pos: value is a change in search positions (negative = better, shown green).
	 * A null value renders an en dash; `why` explains it on hover.
	 */
	let { value, invert = false, mode = 'pct', why = '' }: { value: number | null; invert?: boolean; mode?: 'pct' | 'pos'; why?: string } = $props();
	const flat = $derived(value == null || Math.abs(value) < (mode === 'pos' ? 0.05 : 0.005));
	const good = $derived(flat ? null : mode === 'pos' || invert ? (value as number) < 0 : (value as number) > 0);
	// "flat" changes read as a plain zero, never as a signed "−0.0" or "+0.0%".
	const text = $derived(value == null ? '–' : flat ? (mode === 'pos' ? '0.0' : '0.0%') : mode === 'pos' ? `${value > 0 ? '+' : '−'}${Math.abs(value).toFixed(1)}` : fmtSigned(value));
</script>

<span class="tnum text-xs" class:text-good={good === true} class:text-bad={good === false} class:text-muted={good === null} title={value == null ? why : ''}>{text}</span>
