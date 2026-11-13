<script lang="ts" generics="T">
	import type { Snippet } from 'svelte';
	/**
	 * Long lists (URLs, mostly) show their first rows and one toggle for the rest. It gets the whole list and hands the visible slice to
	 * the snippet, so it works for a <ul> and for table rows alike. A list only a little over the limit is shown whole: a button that
	 * hides two rows is just clutter.
	 */
	let { items, limit = 10, noun = 'items', step = 2, children }: { items: T[]; limit?: number; noun?: string; /** show everything when no more than limit + step */ step?: number; children: Snippet<[T[]]> } = $props();
	let open = $state(false);
	const collapsible = $derived(items.length > limit + step);
	const shown = $derived(collapsible && !open ? items.slice(0, limit) : items);
	const hidden = $derived(items.length - limit);
</script>

{@render children(shown)}
{#if collapsible}
	<button type="button" class="btn mt-2 text-xs" aria-expanded={open} onclick={() => (open = !open)}>
		{open ? 'Show fewer' : `Show ${hidden} more ${noun}`}
	</button>
{/if}
