<script lang="ts">
	import { DropdownMenu } from 'bits-ui';
	import { setMode, userPrefersMode } from 'mode-watcher';
	import { Check, Monitor, Moon, Sun } from '@lucide/svelte';
	import { buttonVariants } from '$lib/components/ui/button';
	import { cn } from '$lib/utils';

	const options = [
		['light', 'Light', Sun],
		['dark', 'Dark', Moon],
		['system', 'System', Monitor]
	] as const;
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger class={cn(buttonVariants({ variant: 'ghost', size: 'icon' }), 'relative')} aria-label="Change theme" title="Theme">
		<Sun class="size-4 scale-100 rotate-0 transition-all dark:scale-0 dark:-rotate-90" />
		<Moon class="absolute size-4 scale-0 rotate-90 transition-all dark:scale-100 dark:rotate-0" />
	</DropdownMenu.Trigger>
	<DropdownMenu.Portal>
		<DropdownMenu.Content align="end" sideOffset={6} class="z-50 min-w-40 rounded-lg border bg-popover p-1 text-popover-foreground shadow-md data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95">
			{#each options as [value, label, Icon]}
				<DropdownMenu.Item onSelect={() => setMode(value)} class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none select-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground">
					<Icon class="size-4 text-muted-foreground" />{label}
					{#if userPrefersMode.current === value}<Check class="ml-auto size-4" />{/if}
				</DropdownMenu.Item>
			{/each}
		</DropdownMenu.Content>
	</DropdownMenu.Portal>
</DropdownMenu.Root>
