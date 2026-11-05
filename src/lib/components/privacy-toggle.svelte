<script lang="ts">
	import { Eye, EyeOff } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import { privacy } from '$lib/privacy.svelte';
	const label = $derived(privacy.on ? 'Privacy mode is on: site names are blurred. Click to show them.' : 'Hide site names (blur them for screenshots and screen sharing).');
</script>

<Button variant="ghost" size="icon" onclick={() => privacy.toggle()} aria-pressed={privacy.on} aria-label={label} title={label}>
	{#if privacy.on}<EyeOff />{:else}<Eye />{/if}
</Button>
