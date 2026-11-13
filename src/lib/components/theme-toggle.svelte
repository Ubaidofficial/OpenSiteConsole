<script lang="ts">
	import { Moon, Sun } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import { theme } from '$lib/theme.svelte';
	const label = $derived(theme.dim ? 'Dim theme is on. Switch to the light theme.' : 'Switch to the dim dark theme.');
</script>

<Button variant="ghost" size="icon" onclick={() => theme.toggle()} aria-pressed={theme.dim} aria-label={label} title={label}>
	{#if theme.dim}<Sun />{:else}<Moon />{/if}
</Button>
