<script lang="ts" generics="Row extends Record<string, any>">
	import { fmtInt, fmtPct, fmtPos, fmtSigned } from '$lib/format';

	interface Col {
		key: string;
		label: string;
		type?: 'text' | 'int' | 'pct' | 'pos' | 'delta' | 'link';
		href?: (row: Row) => string;
		title?: string;
		width?: string;
	}

	let {
		rows,
		cols,
		sortKey = $bindable(cols[1]?.key ?? cols[0].key),
		sortDir = $bindable<'asc' | 'desc'>('desc'),
		pageSize = 50,
		onRowClick,
		empty = 'Nothing to show for this period.',
		filterable = true
	}: {
		rows: Row[];
		cols: Col[];
		sortKey?: string;
		sortDir?: 'asc' | 'desc';
		pageSize?: number;
		onRowClick?: (row: Row) => void;
		empty?: string;
		filterable?: boolean;
	} = $props();

	let page = $state(0);
	let filter = $state('');

	const textKeys = $derived(cols.filter((c) => c.type === 'text' || c.type === 'link' || !c.type).map((c) => c.key));
	const filtered = $derived(filter ? rows.filter((r) => textKeys.some((k) => String(r[k] ?? '').toLowerCase().includes(filter.toLowerCase()))) : rows);
	const sorted = $derived(
		[...filtered].sort((a, b) => {
			const av = a[sortKey];
			const bv = b[sortKey];
			const r = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av ?? '').localeCompare(String(bv ?? ''));
			return sortDir === 'asc' ? r : -r;
		})
	);
	const pages = $derived(Math.max(1, Math.ceil(sorted.length / pageSize)));
	const view = $derived(sorted.slice(page * pageSize, page * pageSize + pageSize));

	$effect(() => {
		filter;
		sortKey;
		page = 0;
	});

	function cell(c: Col, v: unknown): string {
		switch (c.type) {
			case 'int': return fmtInt(v as number);
			case 'pct': return fmtPct(v as number);
			case 'pos': return fmtPos(v as number);
			case 'delta': return fmtSigned(v as number | null);
			default: return String(v ?? '');
		}
	}
	function sortBy(k: string) {
		if (sortKey === k) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
		else (sortKey = k, (sortDir = 'desc'));
	}
</script>

{#if filterable && rows.length > 15}
	<div class="mb-2"><input class="input w-64" placeholder="Filter…" bind:value={filter} /></div>
{/if}
<div class="card overflow-x-auto">
	<table class="w-full border-collapse">
		<thead>
			<tr>
				{#each cols as c}
					<th class="th cursor-pointer select-none" class:text-right={c.type && c.type !== 'text' && c.type !== 'link'} title={c.title} onclick={() => sortBy(c.key)}>
						{c.label}{sortKey === c.key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
					</th>
				{/each}
			</tr>
		</thead>
		<tbody>
			{#each view as row}
				<tr class="hover:bg-muted/50" class:cursor-pointer={!!onRowClick} onclick={() => onRowClick?.(row)}>
					{#each cols as c}
						<td class="td" class:pii={c.key === 'site'} class:text-right={c.type && c.type !== 'text' && c.type !== 'link'} class:tnum={c.type && c.type !== 'text' && c.type !== 'link'} style={c.width ? `max-width:${c.width}` : ''}>
							{#if c.type === 'link'}
								<a class="block max-w-[34rem] truncate text-[color:var(--link)] hover:underline" href={c.href ? c.href(row) : String(row[c.key])} target="_blank" rel="noreferrer noopener" title={String(row[c.key])}>{String(row[c.key]).replace(/^https?:\/\/(www\.)?/, '')}</a>
							{:else if c.type === 'delta'}
								<span class:text-good={(row[c.key] ?? 0) > 0.005} class:text-bad={(row[c.key] ?? 0) < -0.005}>{cell(c, row[c.key])}</span>
							{:else}
								<span class="block max-w-[34rem] truncate" title={String(row[c.key] ?? '')}>{cell(c, row[c.key])}</span>
							{/if}
						</td>
					{/each}
				</tr>
			{:else}
				<tr><td class="td text-muted-foreground" colspan={cols.length}>{empty}</td></tr>
			{/each}
		</tbody>
	</table>
</div>
{#if pages > 1}
	<div class="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
		<button class="btn" disabled={page === 0} onclick={() => page--}>Prev</button>
		<span>Page {page + 1} / {pages} · {fmtInt(sorted.length)} rows</span>
		<button class="btn" disabled={page >= pages - 1} onclick={() => page++}>Next</button>
	</div>
{/if}
