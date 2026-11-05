<script lang="ts">
	import { AlertDialog } from 'bits-ui';
	import { cn } from '$lib/utils';
	import { buttonVariants } from '../button/button.svelte';
	import type { Snippet } from 'svelte';

	/**
	 * A submit button that asks first. Put it inside a <form>; confirming submits that form
	 * (so `use:enhance` and form actions work unchanged). Replaces the browser's window.confirm.
	 */
	let {
		title = 'Are you sure?',
		description = '',
		confirmLabel = 'Confirm',
		destructive = true,
		class: className = 'btn btn-danger',
		children
	}: { title?: string; description?: string; confirmLabel?: string; destructive?: boolean; class?: string; children?: Snippet } = $props();

	let open = $state(false);
	let trigger = $state<HTMLButtonElement | null>(null);

	function confirmed() {
		open = false;
		trigger?.form?.requestSubmit();
	}
</script>

<button type="button" bind:this={trigger} class={className} onclick={() => (open = true)}>{@render children?.()}</button>

<AlertDialog.Root bind:open>
	<AlertDialog.Portal>
		<AlertDialog.Overlay class="fixed inset-0 z-50 bg-black/50 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
		<AlertDialog.Content
			class="fixed top-1/2 left-1/2 z-50 grid w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl border bg-popover p-6 text-popover-foreground shadow-lg data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
		>
			<div class="grid gap-1.5">
				<AlertDialog.Title class="text-base font-semibold">{title}</AlertDialog.Title>
				{#if description}<AlertDialog.Description class="text-sm text-muted-foreground">{description}</AlertDialog.Description>{/if}
			</div>
			<div class="flex justify-end gap-2">
				<AlertDialog.Cancel class={cn(buttonVariants({ variant: 'outline' }))}>Cancel</AlertDialog.Cancel>
				<AlertDialog.Action class={cn(buttonVariants({ variant: destructive ? 'destructive' : 'default' }))} onclick={confirmed}>{confirmLabel}</AlertDialog.Action>
			</div>
		</AlertDialog.Content>
	</AlertDialog.Portal>
</AlertDialog.Root>
