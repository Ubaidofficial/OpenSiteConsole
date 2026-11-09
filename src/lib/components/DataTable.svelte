<script lang="ts" generics="Row extends Record<string, any>">
	import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ChevronsUpDown, Inbox, Search } from '@lucide/svelte';
	import { fmtInt, fmtPct, fmtPos, fmtSigned } from '$lib/format';
	import { privacy } from '$lib/privacy.svelte';
	import { Tip } from '$lib/components/ui/tooltip';
	import { COLUMN_HINT } from '$lib/explain';

	interface Col {
		key: string;
		label: string;
		type?: 'text' | 'int' | 'pct' | 'pos' | 'delta' | 'link';
		href?: (row: Row) => string;
		title?: string;
		width?: string;
		/** Blur this cell in privacy mode. Defaults to true for link columns (page URLs) and the "site" column. */
		pii?: boolean | ((row: Row) => boolean);
		/** Draw a faint in-cell bar proportional to the column maximum (for volume columns like clicks). */
		bar?: boolean;
		/** Columns with the same group name share a labelled header band and a faint tint (for example one band per data source). */
		group?: string;
		/** A CSS colour for the group's tint, such as "var(--c-google)". */
		groupColor?: string;
		/** Row key holding this metric's change as a fraction: shown as a small coloured arrow and percent next to the value. */
		deltaKey?: string;
		/** Text to show for a link column instead of the address (the link still goes to the address). */
		display?: (row: Row) => string;
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

	const numeric = (c: Col) => !!c.type && c.type !== 'text' && c.type !== 'link';
	const isPii = (c: Col, row: Row) => (c.pii === undefined ? c.key === 'site' || c.type === 'link' : typeof c.pii === 'function' ? c.pii(row) : c.pii);

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
	const maxOf = $derived(Object.fromEntries(cols.filter((c) => c.bar).map((c) => [c.key, Math.max(1, ...rows.map((r) => Number(r[c.key]) || 0))])));

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
	/** Native tooltips would reveal blurred text on hover, so they are dropped in privacy mode. */
	const tip = (c: Col, row: Row, text: string) => (privacy.on && isPii(c, row) ? undefined : text);
	/** Header bands: consecutive columns with the same group name, in order. */
	const bands = $derived.by(() => {
		const out: { label: string; span: number; color?: string }[] = [];
		for (const c of cols) {
			const last = out[out.length - 1];
			if (last && last.label === (c.group ?? '')) last.span++;
			else out.push({ label: c.group ?? '', span: 1, color: c.groupColor });
		}
		return out;
	});
	const grouped = $derived(cols.some((c) => c.group));
	const startsGroup = (i: number) => grouped && i > 0 && (cols[i].group ?? '') !== (cols[i - 1].group ?? '');
	const tint = (c: Col) => (c.groupColor ? `background-color:color-mix(in oklab, ${c.groupColor} 7%, transparent);` : '');
	const edge = (i: number) => (startsGroup(i) ? 'border-left:1px solid var(--border);' : '');
	/** "▲ 7%" for a rise, "▼ 4%" for a fall; nothing for no change or no baseline. */
	const deltaText = (v: unknown) => {
		if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) < 0.005) return '';
		const n = Math.abs(v) * 100;
		return `${v > 0 ? '▲' : '▼'} ${n > 999 ? '>999' : n < 10 ? n.toFixed(1).replace(/\.0$/, '') : Math.round(n)}%`;
	};
	const barStyle = (c: Col, row: Row) => {
		const pct = Math.min(100, ((Number(row[c.key]) || 0) / maxOf[c.key]) * 100);
		return `background-image:linear-gradient(to left, color-mix(in oklab, var(--chart-1) 16%, transparent) ${pct}%, transparent ${pct}%)`;
	};
</script>

{#if filterable && rows.length > 15}
	<div class="mb-3 flex items-center gap-3">
		<div class="relative">
			<Search class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
			<input class="input w-72 pl-8" placeholder="Filter…" bind:value={filter} aria-label="Filter rows" />
		</div>
		{#if filter}<span class="text-xs text-muted-foreground tnum">{fmtInt(sorted.length)} of {fmtInt(rows.length)}</span>{/if}
	</div>
{/if}
<div class="overflow-x-auto rounded-xl border bg-card shadow-xs">
	<table class="w-full border-collapse">
		<thead class="bg-muted/40">
			{#if grouped}
				<tr>
					{#each bands as b}
						<th colspan={b.span} class="relative px-3 pt-2.5 pb-1 text-left text-xs font-semibold tracking-wide" style="{b.color ? `background-color:color-mix(in oklab, ${b.color} 12%, transparent);color:color-mix(in oklab, ${b.color} 70%, var(--foreground));` : ''}{b.label ? 'border-left:1px solid var(--border);' : ''}">{#if b.label}{b.label}{:else}<span class="sr-only">Group</span>{/if}</th>
					{/each}
				</tr>
			{/if}
			<tr>
				{#each cols as c, ci}
					<th class="th" class:text-right={numeric(c)} style="{tint(c)}{edge(ci)}" aria-sort={sortKey === c.key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}>
						<Tip interactive text={c.title ?? COLUMN_HINT[c.label] ?? ''}><button class="tap inline-flex items-center gap-1 rounded-sm font-medium transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 {sortKey === c.key ? 'text-foreground' : ''}" onclick={() => sortBy(c.key)}>
							{c.label}
							{#if sortKey === c.key}
								{#if sortDir === 'asc'}<ArrowUp class="size-3" />{:else}<ArrowDown class="size-3" />{/if}
							{:else}
								<ChevronsUpDown class="size-3 opacity-40" />
							{/if}
						</button></Tip>
					</th>
				{/each}
			</tr>
		</thead>
		<tbody>
			{#each view as row, ri}
				<tr class="fade-in transition-colors hover:bg-muted/50" style="--i:{Math.min(ri, 12)}" class:cursor-pointer={!!onRowClick} onclick={() => onRowClick?.(row)}>
					{#each cols as c, ci}
						<td class="td" class:pii={isPii(c, row)} class:text-right={numeric(c)} class:tnum={numeric(c)} style="{tint(c)}{edge(ci)}{c.bar ? barStyle(c, row) : ''}{c.width ? `;max-width:${c.width}` : ''}">
							{#if c.type === 'link'}
								<a class="block max-w-[34rem] truncate text-link hover:underline" href={c.href ? c.href(row) : String(row[c.key])} target="_blank" rel="noreferrer noopener" title={tip(c, row, String(row[c.key]))}>{c.display ? c.display(row) : String(row[c.key]).replace(/^https?:\/\/(www\.)?/, '')}</a>
							{:else if c.type === 'delta'}
								<span class:text-good={(row[c.key] ?? 0) > 0.005} class:text-bad={(row[c.key] ?? 0) < -0.005}>{cell(c, row[c.key])}</span>
							{:else if c.deltaKey}
								<span class="inline-flex items-baseline justify-end gap-1.5 whitespace-nowrap">
									<span>{cell(c, row[c.key])}</span>
									<span class="w-12 text-left text-[11px]" class:text-good={(row[c.deltaKey] ?? 0) > 0.005} class:text-bad={(row[c.deltaKey] ?? 0) < -0.005} class:text-muted-foreground={Math.abs(row[c.deltaKey] ?? 0) <= 0.005}>{deltaText(row[c.deltaKey])}</span>
								</span>
							{:else}
								<span class="block max-w-[34rem] truncate" title={tip(c, row, String(row[c.key] ?? ''))}>{cell(c, row[c.key])}</span>
							{/if}
						</td>
					{/each}
				</tr>
			{:else}
				<tr>
					<td class="td py-10 text-center text-muted-foreground" colspan={cols.length}>
						<Inbox class="mx-auto mb-2 size-6 opacity-50" />{empty}
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>
{#if pages > 1}
	<div class="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
		<button class="btn !h-8 !px-2" disabled={page === 0} onclick={() => page--} aria-label="Previous page"><ChevronLeft class="size-4" /></button>
		<span class="tnum">Page {page + 1} of {pages} · {fmtInt(sorted.length)} rows</span>
		<button class="btn !h-8 !px-2" disabled={page >= pages - 1} onclick={() => page++} aria-label="Next page"><ChevronRight class="size-4" /></button>
	</div>
{/if}
