<script lang="ts">
	import type { Snippet } from 'svelte';
	// One short sentence that is always visible, and the rest of the explanation folded away until someone wants it.
	let { lead, label = 'How this works', children }: { lead: string; label?: string; children?: Snippet } = $props();
</script>

<div class="mb-3 max-w-3xl text-sm text-muted-foreground">
	<p>{lead}</p>
	{#if children}
		<details class="mt-1 text-xs"><summary class="cursor-pointer select-none underline-offset-2 hover:underline">{label}</summary><div class="mt-1.5 space-y-1.5 leading-relaxed">{@render children()}</div></details>
	{/if}
</div>
