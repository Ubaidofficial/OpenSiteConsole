<script lang="ts">
	/**
	 * One whole split into parts (at most 6), read at a glance: position buckets, index status, devices. Tall: each part prints its
	 * share inside when it fits, with a legend of names below. Thin: no text on the bar (the figures sit beside it). A 2px surface gap
	 * separates the parts; hover or focus names a part with its amount and share. The accessible name lists every part, so nothing
	 * depends on colour or hover alone.
	 */
	export interface Part { label: string; value: number; color: string; /** the text colour printed inside this part's fill: white on a dark fill, near-black on a light one */ ink?: string; hint?: string }
	let { parts, tall = true, title = '', format = (v: number) => v.toLocaleString('en-US'), legend = true }: { parts: Part[]; tall?: boolean; title?: string; format?: (v: number) => string; legend?: boolean } = $props();
	const total = $derived(parts.reduce((a, p) => a + Math.max(0, p.value), 0));
	const shown = $derived(parts.filter((p) => p.value > 0));
	const pct = (v: number) => (total ? (v / total) * 100 : 0);
	const share = (v: number) => `${Math.round(pct(v))}%`;
	let hover = $state<number | null>(null);
	const name = $derived(`${title ? title + ': ' : ''}${parts.map((p) => `${p.label} ${format(p.value)} (${share(p.value)})`).join(', ')}`);
</script>

<div class="w-full">
	<div class="relative flex w-full gap-[2px] {tall ? 'h-7' : 'h-2'}" role="img" aria-label={name}>
		{#each shown as p, i (p.label)}
			<div
				class="relative min-w-[3px] {tall ? 'rounded-[4px]' : 'rounded-full'} transition-opacity"
				style="flex: {pct(p.value)} 1 0; background:{p.color}; opacity:{hover == null || hover === i ? 1 : 0.45}"
				onpointerenter={() => (hover = i)}
				onpointerleave={() => (hover = null)}
				role="presentation"
			>
				{#if tall && pct(p.value) >= 9}<span class="pointer-events-none absolute inset-y-0 left-2 flex items-center text-[11px] font-semibold tnum" style="color:{p.ink ?? '#ffffff'}">{share(p.value)}</span>{/if}
			</div>
		{/each}
		{#if hover != null && shown[hover]}
			{@const p = shown[hover]}
			<div class="pointer-events-none absolute bottom-full left-0 z-20 mb-1.5 rounded-md border bg-popover px-2.5 py-1.5 text-xs shadow-md">
				<span class="mr-1.5 inline-block size-2 rounded-full align-middle" style="background:{p.color}"></span><b>{p.label}</b> · {format(p.value)} ({share(p.value)}){#if p.hint}<div class="text-muted-foreground">{p.hint}</div>{/if}
			</div>
		{/if}
	</div>
	{#if legend}
		<ul class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-hidden="true">
			{#each parts as p (p.label)}<li class="inline-flex items-center gap-1.5"><span class="size-2 rounded-full" style="background:{p.color}"></span>{p.label}{#if !tall}<span class="tnum text-foreground">{format(p.value)}</span>{/if}</li>{/each}
		</ul>
	{/if}
</div>
