<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import DataTable from '$lib/components/DataTable.svelte';
	import Chart from '$lib/components/Chart.svelte';

	let { data } = $props();
	let open = $state<string | null>(null);
	let history = $state<any[]>([]);
	let loading = $state(false);

	function setParam(k: string, v: string) {
		const u = new URL(page.url);
		v ? u.searchParams.set(k, v) : u.searchParams.delete(k);
		goto(u.pathname + u.search, { keepFocus: true });
	}
	async function toggle(row: { query: string }) {
		if (open === row.query) return (open = null);
		open = row.query;
		loading = true;
		const u = `/sites/${page.params.id}/history?kind=query&value=${encodeURIComponent(row.query)}&days=480`;
		history = await fetch(u).then((r) => r.json());
		loading = false;
	}
	const cols = [
		{ key: 'query', label: 'Query', type: 'text' as const, pii: (r: { branded: boolean }) => r.branded },
		{ key: 'clicks', label: 'Clicks', type: 'int' as const, bar: true },
		{ key: 'clicksDelta', label: 'Δ %', title: 'Change in clicks compared with the previous period of the same length (for example +9.5% = 9.5% more clicks than before). A dash means there were no clicks before, so there is no percentage.', type: 'delta' as const },
		{ key: 'impressions', label: 'Impressions', type: 'int' as const },
		{ key: 'ctr', label: 'CTR', type: 'pct' as const },
		{ key: 'position', label: 'Position', type: 'pos' as const }
	];
</script>

<div class="mb-3 flex flex-wrap items-center gap-2">
	<select class="input" value={data.b} onchange={(e) => setParam('b', e.currentTarget.value)}>
		<option value="all">All queries</option><option value="nonbrand">Non-branded</option><option value="brand">Branded</option>
	</select>
	<select class="input" value={data.onlyQuestions ? 'questions' : ''} onchange={(e) => setParam('q', e.currentTarget.value)} title="Question-style queries: how, what, why, can… or containing a question mark (English only)">
		<option value="">Any wording</option><option value="questions">Questions only</option>
	</select>
	<select class="input" value={data.filters.country ?? ''} onchange={(e) => setParam('country', e.currentTarget.value)}>
		<option value="">All countries</option>{#each data.countries as c}<option value={c}>{c.toUpperCase()}</option>{/each}
	</select>
	<select class="input" value={data.filters.device ?? ''} onchange={(e) => setParam('device', e.currentTarget.value)}>
		<option value="">All devices</option>{#each data.devices as d}<option value={d}>{d}</option>{/each}
	</select>
	<a class="btn ml-auto" href="/sites/{page.params.id}/export?dim=query&days={page.url.searchParams.get('days') ?? 28}">Export CSV</a>
</div>
<p class="mb-2 text-xs text-muted-foreground">Branded = contains <span class="pii">{data.brandTerms.length ? data.brandTerms.join(', ') : '(no brand terms — set them in Settings)'}</span>. Click a row for its full-history chart.</p>

<DataTable rows={data.rows} {cols} sortKey="clicks" onRowClick={toggle} />

{#if open}
	<div class="card mt-3 p-4">
		<div class="mb-2 font-medium">“<span class="pii">{open}</span>” — all stored history</div>
		{#if loading}<p class="text-muted-foreground">Loading…</p>{:else}<Chart data={history} defaultMetrics={['clicks', 'position']} height={220} />{/if}
	</div>
{/if}
