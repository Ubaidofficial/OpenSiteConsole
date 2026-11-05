<script lang="ts">
	import { page } from '$app/state';
	import { PERIODS } from '$lib/periods';
	let { days }: { days: number } = $props();
	const href = (d: number) => {
		const u = new URL(page.url);
		u.searchParams.set('days', String(d));
		return u.pathname + u.search;
	};
	const label = (d: number) => (d === 480 ? '16m' : d === 180 ? '6m' : d === 90 ? '3m' : `${d}d`);
</script>

<div class="inline-flex rounded-lg bg-muted p-0.5" role="group" aria-label="Period">
	{#each PERIODS as d}
		<a
			href={href(d)}
			aria-current={d === days ? 'true' : undefined}
			class="rounded-md px-2.5 py-1 text-xs font-medium transition-all {d === days ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'}">{label(d)}</a
		>
	{/each}
</div>
