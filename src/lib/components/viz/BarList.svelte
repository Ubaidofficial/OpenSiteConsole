<script lang="ts">
	/**
	 * Ranked horizontal bars, largest first: compare a handful of items by one measure (reasons pages are not indexed, opportunity
	 * sizes, assistants). One hue for every bar (the length is the data; colour adds nothing). Bars are thin with a 4px rounded end;
	 * the label sits above the bar and the value at its tip, so every number is readable without hovering.
	 */
	export interface Item { label: string; value: number; href?: string; note?: string; pii?: boolean }
	let { items, max = null, color = 'var(--chart-1)', format = (v: number) => v.toLocaleString('en-US'), unit = '', limit = 8 }: { items: Item[]; max?: number | null; color?: string; format?: (v: number) => string; unit?: string; limit?: number } = $props();
	const top = $derived([...items].sort((a, b) => b.value - a.value).slice(0, limit));
	const m = $derived(max ?? Math.max(1, ...top.map((i) => i.value)));
</script>

<ul class="space-y-2.5">
	{#each top as it (it.label)}
		<li>
			<div class="mb-1 flex items-baseline gap-2 text-sm">
				{#if it.href}<a href={it.href} class="min-w-0 truncate hover:underline" class:pii={it.pii} title={it.label}>{it.label}</a>{:else}<span class="min-w-0 truncate" class:pii={it.pii} title={it.label}>{it.label}</span>{/if}
				{#if it.note}<span class="truncate text-xs text-muted-foreground">{it.note}</span>{/if}
				<span class="tnum ml-auto shrink-0 font-medium">{format(it.value)}{#if unit}<span class="ml-1 text-xs font-normal text-muted-foreground">{unit}</span>{/if}</span>
			</div>
			<div class="h-2 w-full rounded-full bg-muted" aria-hidden="true"><div class="h-2 rounded-r-[4px] rounded-l-full" style="width:{Math.max(1.5, (it.value / m) * 100)}%; background:{color}"></div></div>
		</li>
	{/each}
</ul>
{#if items.length > limit}<p class="mt-2 text-xs text-muted-foreground">and {items.length - limit} more</p>{/if}
