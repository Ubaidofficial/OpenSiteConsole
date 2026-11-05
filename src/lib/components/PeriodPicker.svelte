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

<div class="inline-flex gap-1" role="group" aria-label="Period">
	{#each PERIODS as d}
		<a href={href(d)} class="chip" class:chip-on={d === days}>{label(d)}</a>
	{/each}
</div>
