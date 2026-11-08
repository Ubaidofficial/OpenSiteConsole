<script lang="ts">
	import { POSITION_BUCKETS } from '$lib/plan';
	/**
	 * Where searches rank, week by week: one stacked column per week, best bucket at the bottom (so a growing dark base reads as
	 * "more searches near the top"), ordered steps of one hue as in the bar above it. Columns are thin with a 2px gap between
	 * segments; hover or focus a week for its counts. The legend is the bucket row above this chart.
	 */
	let { weeks, height = 120 }: { weeks: { start: string; end: string; counts: number[] }[]; height?: number } = $props();
	let width = $state(600);
	const pad = { l: 34, r: 6, t: 8, b: 20 };
	const maxTotal = $derived(Math.max(1, ...weeks.map((w) => w.counts.reduce((a, b) => a + b, 0))));
	const step = $derived(Math.ceil(maxTotal / 2 / 10) * 10 || 1);
	const top = $derived(step * Math.ceil(maxTotal / step));
	const band = $derived((width - pad.l - pad.r) / Math.max(1, weeks.length));
	const barW = $derived(Math.min(24, band * 0.6));
	const innerH = $derived(height - pad.t - pad.b);
	const Y = (v: number) => pad.t + innerH - (v / top) * innerH;
	let hover = $state<number | null>(null);
	const fmt = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
	const stacks = $derived(
		weeks.map((w, i) => {
			let acc = 0;
			const segs = w.counts.map((c, k) => {
				const y1 = Y(acc);
				acc += c;
				const y0 = Y(acc);
				return { k, c, y: y0, h: Math.max(0, y1 - y0 - (c ? 2 : 0)) }; // 2px surface gap between segments
			});
			return { i, x: pad.l + band * i + (band - barW) / 2, segs, total: acc, w };
		})
	);
</script>

{#if weeks.length >= 2}
	<div class="relative w-full" bind:clientWidth={width}>
		<svg {width} {height} role="img" aria-label="Searches by position, week by week: {weeks.map((w) => `week of ${fmt(w.start)}: ${POSITION_BUCKETS.map((b, k) => `${b.label} ${w.counts[k]}`).join(', ')}`).join('; ')}">
			{#each [0, step, top].filter((v, i, a) => a.indexOf(v) === i) as t}
				<line x1={pad.l} x2={width - pad.r} y1={Y(t)} y2={Y(t)} stroke={t === 0 ? 'var(--axis)' : 'var(--grid)'} stroke-width="1" />
				<text x={pad.l - 6} y={Y(t) + 3} text-anchor="end" class="tnum fill-muted-foreground text-[10px]">{t}</text>
			{/each}
			{#each stacks as s (s.i)}
				<g opacity={hover == null || hover === s.i ? 1 : 0.5} role="presentation" onpointerenter={() => (hover = s.i)} onpointerleave={() => (hover = null)}>
					<rect x={s.x - (band - barW) / 2} y={pad.t} width={band} height={innerH} fill="transparent" />
					{#each s.segs as g (g.k)}
						{#if g.c}<rect x={s.x} y={g.y} width={barW} height={g.h} rx={g.k === s.segs.findLastIndex((z) => z.c) ? 3 : 0} fill="var(--ord-{g.k + 1})" />{/if}
					{/each}
				</g>
			{/each}
			{#each stacks.filter((s, i) => i === 0 || i === stacks.length - 1 || i === Math.floor(stacks.length / 2)) as s (s.i)}
				<text x={s.x + barW / 2} y={height - 5} text-anchor="middle" class="fill-muted-foreground text-[10px]">{fmt(s.w.start)}</text>
			{/each}
		</svg>
		{#if hover != null}
			{@const s = stacks[hover]}
			<div class="pointer-events-none absolute z-20 rounded-md border bg-popover px-2.5 py-1.5 text-xs shadow-md" style="left:{Math.min(s.x + barW + 8, width - 180)}px; top:0">
				<div class="mb-1 font-medium">Week of {fmt(s.w.start)}</div>
				{#each POSITION_BUCKETS as b, k}<div class="flex items-center justify-between gap-4 tnum"><span class="inline-flex items-center gap-1.5 text-muted-foreground"><span class="size-2 rounded-sm" style="background:var(--ord-{k + 1})"></span>{b.label}</span><span>{s.w.counts[k]}</span></div>{/each}
			</div>
		{/if}
	</div>
{/if}
