<script lang="ts">
	import { Tooltip } from 'bits-ui';
	import type { Snippet } from 'svelte';

	/** Wraps its children; shows `text` on hover/focus. Does nothing when `text` is empty. */
	let { text = '', children }: { text?: string; children: Snippet } = $props();
</script>

{#if text}
	<Tooltip.Provider delayDuration={150}>
		<Tooltip.Root>
			<Tooltip.Trigger class="cursor-help rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50">{@render children()}</Tooltip.Trigger>
			<Tooltip.Portal>
				<Tooltip.Content sideOffset={6} class="z-50 max-w-64 rounded-md bg-primary px-3 py-1.5 text-xs text-balance text-primary-foreground shadow-md animate-in fade-in-0 zoom-in-95">{text}</Tooltip.Content>
			</Tooltip.Portal>
		</Tooltip.Root>
	</Tooltip.Provider>
{:else}
	{@render children()}
{/if}
