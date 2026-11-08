<script lang="ts">
	import SegBar from './SegBar.svelte';
	import { POSITION_BUCKETS } from '$lib/plan';
	/**
	 * Where the site's searches rank: one bar split into top 3 / 4-10 / 11-20 / below 20 (ordered steps of one hue, best first), with
	 * each bucket's count and its change against the previous period printed under it, so the shift reads without hovering.
	 */
	let { now, prev = null }: { now: number[]; prev?: number[] | null } = $props();
	const total = $derived(now.reduce((a, b) => a + b, 0));
	const parts = $derived(POSITION_BUCKETS.map((b, i) => ({ label: b.label, value: now[i], color: `var(--ord-${i + 1})`, ink: `var(--ord-ink-${i + 1})` })));
	// moving up is good for the top three buckets and bad for "below 20"
	const goodUp = [true, true, true, false];
</script>

{#if total > 0}
	<SegBar {parts} title="Searches by position" legend={false} format={(v) => `${v} searches`} />
	<dl class="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
		{#each POSITION_BUCKETS as b, i}
			{@const d = prev ? now[i] - prev[i] : null}
			<div>
				<dt class="flex items-center gap-1.5 text-xs text-muted-foreground"><span class="size-2 rounded-sm" style="background:var(--ord-{i + 1})"></span>{b.label}</dt>
				<dd class="mt-0.5 flex items-baseline gap-1.5">
					<span class="text-lg font-semibold">{now[i].toLocaleString('en-US')}</span>
					{#if d != null && d !== 0}<span class="tnum text-xs font-medium {(d > 0) === goodUp[i] ? 'text-good' : 'text-bad'}">{d > 0 ? '+' : '−'}{Math.abs(d)}</span>{:else if d === 0}<span class="text-xs text-muted-foreground">no change</span>{/if}
				</dd>
			</div>
		{/each}
	</dl>
{:else}
	<p class="text-sm text-muted-foreground">Not enough searches yet to show where they rank.</p>
{/if}
