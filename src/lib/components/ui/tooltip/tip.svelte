<script lang="ts">
	import { Tooltip } from 'bits-ui';
	import type { Snippet } from 'svelte';

	/**
	 * Wraps its children; shows `text` on hover and on keyboard focus. Does nothing when `text` is empty.
	 * The trigger is a span, so it can wrap a button or a link without nesting one button inside another.
	 * Pass `interactive` when the child is itself a button or link: the wrapper then drops out of the tab order, so
	 * keyboard users get one stop, not two (the child has its own visible label; the tip is extra for mouse users).
	 */
	let { text = '', interactive = false, children }: { text?: string; interactive?: boolean; children: Snippet } = $props();
</script>

{#if text}
	<Tooltip.Provider delayDuration={150}>
		<Tooltip.Root>
			<Tooltip.Trigger>
				{#snippet child({ props })}
					<span {...props} {...interactive ? { tabindex: -1 } : {}} class="inline-flex cursor-help rounded-sm outline-none focus-within:ring-2 focus-within:ring-ring/50 focus-visible:ring-2 focus-visible:ring-ring/50">{@render children()}</span>
				{/snippet}
			</Tooltip.Trigger>
			<Tooltip.Portal>
				<Tooltip.Content sideOffset={6} class="z-50 max-w-64 rounded-md bg-primary px-3 py-1.5 text-xs text-balance text-primary-foreground shadow-md animate-in fade-in-0 zoom-in-95">{text}</Tooltip.Content>
			</Tooltip.Portal>
		</Tooltip.Root>
	</Tooltip.Provider>
{:else}
	{@render children()}
{/if}
