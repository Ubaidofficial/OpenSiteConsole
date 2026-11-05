<script lang="ts">
	import { setMode, userPrefersMode } from 'mode-watcher';
	import { Monitor, Moon, Sun } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';

	const order = ['light', 'dark', 'system'] as const;
	const next = () => setMode(order[(order.indexOf(userPrefersMode.current as (typeof order)[number]) + 1) % order.length]);
	const label = $derived(`Theme: ${userPrefersMode.current}. Click to change.`);
</script>

<Button variant="ghost" size="icon" onclick={next} aria-label={label} title={label}>
	{#if userPrefersMode.current === 'light'}<Sun />{:else if userPrefersMode.current === 'dark'}<Moon />{:else}<Monitor />{/if}
</Button>
