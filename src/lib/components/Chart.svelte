<script lang="ts">
	import { untrack } from 'svelte';
	import { fmtCompact, fmtInt, fmtPos } from '$lib/format';

	interface Point { date: string; clicks: number; impressions: number; position: number }
	interface Marker { date: string; label: string; color?: string }
	type Key = 'clicks' | 'impressions' | 'position';

	let {
		data,
		markers = [],
		anomalies = [],
		height = 280,
		defaultMetrics = ['clicks', 'impressions'],
		labels = {},
		hide = [],
		dashed = 2
	}: {
		data: Point[];
		markers?: Marker[];
		anomalies?: { date: string; direction: string }[];
		height?: number;
		defaultMetrics?: string[];
		/** Rename a series, e.g. { clicks: 'GA4 organic sessions' } */
		labels?: Partial<Record<Key, string>>;
		hide?: Key[];
		/** The last N days are provisional (Search Console revises them) and drawn dashed. */
		dashed?: number;
	} = $props();

	const uid = $props.id();
	const BASE: { key: Key; label: string; color: string }[] = [
		{ key: 'clicks', label: 'Clicks', color: 'var(--c-clicks)' },
		{ key: 'impressions', label: 'Impressions', color: 'var(--c-impr)' },
		{ key: 'position', label: 'Avg position', color: 'var(--c-pos)' }
	];
	const METRICS = $derived(BASE.filter((m) => !hide.includes(m.key)).map((m) => ({ ...m, label: labels[m.key] ?? m.label })));

	let on = $state<string[]>(untrack(() => [...defaultMetrics]));
	let width = $state(800);
	let hover = $state<number | null>(null);

	const pad = { l: 40, r: 12, t: 14, b: 26 };
	const innerW = $derived(Math.max(10, width - pad.l - pad.r));
	const innerH = $derived(height - pad.t - pad.b);
	const x = (i: number) => pad.l + (data.length <= 1 ? innerW / 2 : (i / (data.length - 1)) * innerW);
	const active = $derived(METRICS.filter((m) => on.includes(m.key)));

	/** Each metric is scaled to its own range; position is inverted because lower is better. */
	function scaleOf(key: Key) {
		const vals = data.map((d) => d[key]).filter((v) => key !== 'position' || v > 0);
		const max = Math.max(1, ...vals);
		const min = key === 'position' ? Math.min(...vals, max) : 0;
		const y = (v: number) => {
			const t = max === min ? 0.5 : (v - min) / (max - min);
			return pad.t + (key === 'position' ? t : 1 - t) * innerH;
		};
		return { max, min, y };
	}

	const series = $derived(
		active.map((m) => {
			const { y, max, min } = scaleOf(m.key);
			const cut = Math.max(1, data.length - dashed);
			let solid = '';
			let tail = '';
			let pen = false;
			data.forEach((p, i) => {
				if (m.key === 'position' && !p.position) {
					pen = false;
					return;
				}
				const seg = `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[m.key]).toFixed(1)}`;
				if (i <= cut) solid += seg;
				else tail += (i === cut + 1 ? `M${x(cut).toFixed(1)},${y(data[cut][m.key]).toFixed(1)}` : '') + `L${x(i).toFixed(1)},${y(p[m.key]).toFixed(1)}`;
				pen = true;
			});
			// The fill needs one continuous outline (solid + dashed tail would start a second sub-path and skew the shape).
			const outline = data.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[m.key]).toFixed(1)}`).join('');
			const area = m.key === 'position' || data.length < 2 ? '' : `${outline}L${x(data.length - 1).toFixed(1)},${pad.t + innerH}L${x(0).toFixed(1)},${pad.t + innerH}Z`;
			return { ...m, y, max, min, solid, tail, area };
		})
	);

	const idx = (date: string) => data.findIndex((d) => d.date === date);
	const ticks = $derived(data.length ? [...new Set([0, 0.2, 0.4, 0.6, 0.8, 1].map((t) => Math.round(t * (data.length - 1))))] : []);
	const fmtDay = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
	const fmtLong = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
	const yTicks = $derived(
		series[0] && series[0].key !== 'position'
			? [0.25, 0.5, 0.75, 1].map((t) => ({ y: pad.t + (1 - t) * innerH, v: series[0].max * t }))
			: []
	);

	function move(e: PointerEvent) {
		const r = (e.currentTarget as SVGElement).getBoundingClientRect();
		const rel = (e.clientX - r.left - pad.l) / innerW;
		hover = Math.min(data.length - 1, Math.max(0, Math.round(rel * (data.length - 1))));
	}
	const tipLeft = $derived(hover === null ? 0 : Math.min(Math.max(x(hover) - 80, 4), width - 176));
</script>

<div class="relative" bind:clientWidth={width}>
	<div class="mb-3 flex flex-wrap gap-1.5" role="group" aria-label="Series">
		{#each METRICS as m}
			{@const isOn = on.includes(m.key)}
			<button
				class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors {isOn ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent/60'}"
				aria-pressed={isOn}
				onclick={() => (on = on.includes(m.key) ? on.filter((k) => k !== m.key) : [...on, m.key])}
			>
				<span class="size-2 rounded-full transition-opacity" style="background:{m.color};opacity:{isOn ? 1 : 0.3}"></span>{m.label}
			</button>
		{/each}
	</div>

	{#if data.length === 0}
		<div class="flex items-center justify-center text-muted-foreground" style="height:{height}px">No data in this period yet</div>
	{:else}
		<svg {width} {height} role="img" aria-label="Traffic chart" onpointermove={move} onpointerleave={() => (hover = null)} class="reveal-x touch-none select-none">
			<defs>
				{#each series as s}
					<linearGradient id="g-{uid}-{s.key}" x1="0" y1="0" x2="0" y2="1">
						<stop offset="0%" stop-color={s.color} stop-opacity="0.26" />
						<stop offset="100%" stop-color={s.color} stop-opacity="0" />
					</linearGradient>
				{/each}
			</defs>

			{#each yTicks as t}
				<line x1={pad.l} x2={width - pad.r} y1={t.y} y2={t.y} stroke="var(--border)" stroke-dasharray="2 4" />
				<text x={pad.l - 8} y={t.y + 3.5} font-size="10.5" fill="var(--muted-foreground)" text-anchor="end" class="tnum">{fmtCompact(Math.round(t.v))}</text>
			{/each}
			<line x1={pad.l} x2={width - pad.r} y1={pad.t + innerH} y2={pad.t + innerH} stroke="var(--border)" />

			{#each anomalies as an}
				{@const i = idx(an.date)}
				{#if i >= 0}
					<rect x={x(i) - 4} y={pad.t} width="8" height={innerH} rx="3" fill={an.direction === 'drop' ? 'var(--bad)' : 'var(--good)'} opacity="0.13" />
				{/if}
			{/each}

			{#each markers as mk}
				{@const i = idx(mk.date)}
				{#if i >= 0}
					<line x1={x(i)} x2={x(i)} y1={pad.t} y2={pad.t + innerH} stroke={mk.color ?? 'var(--warn)'} stroke-dasharray="3 3" opacity="0.7" />
					<circle cx={x(i)} cy={pad.t + 4} r="4.5" fill={mk.color ?? 'var(--warn)'} stroke="var(--card)" stroke-width="1.5"><title>{mk.date}: {mk.label}</title></circle>
				{/if}
			{/each}

			{#each series as s, k}
				{#if k === 0 && s.area}<path d={s.area} fill="url(#g-{uid}-{s.key})" />{/if}
				<path d={s.solid} fill="none" stroke={s.color} stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
				{#if s.tail}<path d={s.tail} fill="none" stroke={s.color} stroke-width="2" stroke-dasharray="3 4" stroke-linecap="round" opacity="0.7" />{/if}
			{/each}

			{#each ticks as t}
				<text x={x(t)} y={height - 7} font-size="10.5" fill="var(--muted-foreground)" text-anchor={t === 0 ? 'start' : t === data.length - 1 ? 'end' : 'middle'}>{fmtDay(data[t].date)}</text>
			{/each}

			{#if hover !== null}
				<line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + innerH} stroke="var(--muted-foreground)" opacity="0.45" />
				{#each series as s}
					{#if s.key !== 'position' || data[hover].position}
						<circle cx={x(hover)} cy={s.y(data[hover][s.key])} r="4" fill={s.color} stroke="var(--card)" stroke-width="2" />
					{/if}
				{/each}
			{/if}
		</svg>

		{#if hover !== null}
			{@const p = data[hover]}
			<div class="pointer-events-none absolute z-10 rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md" style="top:44px;left:{tipLeft}px;min-width:9.5rem">
				<div class="mb-1.5 font-medium">{fmtLong(p.date)}{#if hover >= data.length - dashed}<span class="ml-1 font-normal text-muted-foreground">· provisional</span>{/if}</div>
				{#each active as m}
					<div class="flex items-center justify-between gap-4 tnum">
						<span class="inline-flex items-center gap-1.5 text-muted-foreground"><span class="size-2 rounded-full" style="background:{m.color}"></span>{m.label}</span>
						<span class="font-medium text-foreground">{m.key === 'position' ? (p.position ? fmtPos(p.position) : '–') : fmtInt(p[m.key])}</span>
					</div>
				{/each}
			</div>
		{/if}
	{/if}
</div>
