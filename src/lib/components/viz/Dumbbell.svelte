<script lang="ts">
	/**
	 * Before -> after per item on one shared scale: decaying pages, lost and rising searches. The "before" dot is a light step of the
	 * hue, the "after" dot the full hue, joined by a line; the change is printed at the right, so it never depends on reading dots.
	 * `better` says which direction is good, so a drop in clicks reads red and a rise reads green (with a sign, never colour alone).
	 */
	export interface Row { label: string; before: number; after: number; href?: string; pii?: boolean }
	let { rows, format = (v: number) => Math.round(v).toLocaleString('en-US'), better = 'up', beforeLabel = 'before', afterLabel = 'now', limit = 8, change = 'pct', unit = '' }: { rows: Row[]; format?: (v: number) => string; better?: 'up' | 'down'; beforeLabel?: string; afterLabel?: string; limit?: number; /** 'abs' prints the difference itself (for positions: places), 'pct' the relative change */ change?: 'pct' | 'abs'; unit?: string } = $props();
	const top = $derived(rows.slice(0, limit));
	const max = $derived(Math.max(1, ...top.flatMap((r) => [r.before, r.after])));
	const x = (v: number) => (Math.max(0, v) / max) * 100;
	const delta = (r: Row) => {
		const d = r.after - r.before;
		const pct = r.before ? d / r.before : null;
		const good = better === 'up' ? d >= 0 : d <= 0;
		return { d, pct, good };
	};
</script>

<div>
	<div class="mb-2 flex items-center gap-4 text-xs text-muted-foreground" aria-hidden="true">
		<span class="inline-flex items-center gap-1.5"><span class="size-2.5 rounded-full border-2" style="border-color:var(--chart-1); background:var(--card)"></span>{beforeLabel}</span>
		<span class="inline-flex items-center gap-1.5"><span class="size-2.5 rounded-full" style="background:var(--chart-1)"></span>{afterLabel}</span>
	</div>
	<ul class="space-y-3">
		{#each top as r (r.label)}
			{@const d = delta(r)}
			<li aria-label="{r.label}: {format(r.before)} {beforeLabel}, {format(r.after)} {afterLabel}">
				<div class="mb-1 flex items-baseline gap-2 text-sm">
					{#if r.href}<a href={r.href} class="min-w-0 truncate hover:underline" class:pii={r.pii} title={r.label}>{r.label}</a>{:else}<span class="min-w-0 truncate" class:pii={r.pii} title={r.label}>{r.label}</span>{/if}
					<span class="tnum ml-auto shrink-0 text-xs text-muted-foreground">{format(r.before)} → <b class="text-foreground">{format(r.after)}</b></span>
					<span class="tnum min-w-14 shrink-0 whitespace-nowrap text-right text-xs font-semibold {d.good ? 'text-good' : 'text-bad'}">{change === 'abs' ? `${d.d >= 0 ? '+' : '−'}${Math.abs(d.d).toFixed(1)}${unit ? ' ' + unit : ''}` : d.pct == null ? 'new' : `${d.d >= 0 ? '+' : '−'}${Math.round(Math.abs(d.pct) * 100)}%`}</span>
				</div>
				<div class="relative h-3" aria-hidden="true">
					<div class="absolute inset-x-0 top-1/2 h-px -translate-y-1/2" style="background:var(--grid)"></div>
					<div class="absolute top-1/2 h-0.5 -translate-y-1/2 rounded" style="left:{Math.min(x(r.before), x(r.after))}%; width:{Math.abs(x(r.after) - x(r.before))}%; background:var(--chart-1); opacity:.45"></div>
					<span class="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2" style="left:{x(r.before)}%; border-color:var(--chart-1); background:var(--card)"></span>
					<span class="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-[color:var(--card)]" style="left:{x(r.after)}%; background:var(--chart-1)"></span>
				</div>
			</li>
		{/each}
	</ul>
	{#if rows.length > limit}<p class="mt-2 text-xs text-muted-foreground">and {rows.length - limit} more in the table below</p>{/if}
</div>
