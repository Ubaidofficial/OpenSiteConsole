<script lang="ts">
	import { untrack } from 'svelte';
	import { fmtInt, fmtPos } from '$lib/format';

	interface Point { date: string; clicks: number; impressions: number; position: number }
	interface Marker { date: string; label: string; color?: string }

	let {
		data,
		markers = [],
		anomalies = [],
		height = 260,
		defaultMetrics = ['clicks', 'impressions'],
		labels = {},
		hide = []
	}: {
		data: Point[];
		markers?: Marker[];
		anomalies?: { date: string; direction: string }[];
		height?: number;
		defaultMetrics?: string[];
		/** Rename a series, e.g. { clicks: 'GA4 organic sessions' } */
		labels?: Partial<Record<'clicks' | 'impressions' | 'position', string>>;
		hide?: ('clicks' | 'impressions' | 'position')[];
	} = $props();

	type Key = 'clicks' | 'impressions' | 'position';
	const BASE: { key: Key; label: string; color: string }[] = [
		{ key: 'clicks', label: 'Clicks', color: 'var(--c-clicks)' },
		{ key: 'impressions', label: 'Impressions', color: 'var(--c-impr)' },
		{ key: 'position', label: 'Avg position', color: 'var(--c-pos)' }
	];
	const METRICS = $derived(BASE.filter((m) => !hide.includes(m.key)).map((m) => ({ ...m, label: labels[m.key] ?? m.label })));

	let on = $state<string[]>(untrack(() => [...defaultMetrics]));
	let width = $state(800);
	let hover = $state<number | null>(null);

	const pad = { l: 8, r: 8, t: 12, b: 22 };
	const innerW = $derived(Math.max(10, width - pad.l - pad.r));
	const innerH = $derived(height - pad.t - pad.b);
	const x = (i: number) => pad.l + (data.length <= 1 ? innerW / 2 : (i / (data.length - 1)) * innerW);

	function scale(key: Key) {
		const vals = data.map((d) => d[key]);
		const max = Math.max(1, ...vals);
		const min = key === 'position' ? Math.min(...vals.filter((v) => v > 0), max) : 0;
		return (v: number) => {
			const t = max === min ? 0.5 : (v - min) / (max - min);
			// position: lower is better, so draw it inverted (best at the top)
			return pad.t + (key === 'position' ? t : 1 - t) * innerH;
		};
	}

	const paths = $derived(
		METRICS.filter((m) => on.includes(m.key)).map((m) => {
			const y = scale(m.key);
			const d = data.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[m.key]).toFixed(1)}`).join('');
			return { ...m, d };
		})
	);

	const idx = (date: string) => data.findIndex((d) => d.date === date);
	const ticks = $derived(data.length ? [0, 0.25, 0.5, 0.75, 1].map((t) => Math.round(t * (data.length - 1))) : []);

	function move(e: PointerEvent) {
		const r = (e.currentTarget as SVGElement).getBoundingClientRect();
		const rel = (e.clientX - r.left - pad.l) / innerW;
		hover = Math.min(data.length - 1, Math.max(0, Math.round(rel * (data.length - 1))));
	}
</script>

<div class="relative" bind:clientWidth={width}>
	<div class="mb-2 flex flex-wrap gap-2">
		{#each METRICS as m}
			<button
				class="chip cursor-pointer"
				class:chip-on={on.includes(m.key)}
				style={on.includes(m.key) ? `background:${m.color};border-color:${m.color}` : ''}
				onclick={() => (on = on.includes(m.key) ? on.filter((k) => k !== m.key) : [...on, m.key])}>{m.label}</button
			>
		{/each}
	</div>
	{#if data.length === 0}
		<div class="flex items-center justify-center text-muted" style="height:{height}px">No data in this period yet</div>
	{:else}
		<svg {width} {height} role="img" aria-label="Traffic chart" onpointermove={move} onpointerleave={() => (hover = null)} class="touch-none">
			{#each [0.25, 0.5, 0.75] as g}
				<line x1={pad.l} x2={width - pad.r} y1={pad.t + g * innerH} y2={pad.t + g * innerH} stroke="var(--line)" stroke-dasharray="2 4" />
			{/each}
			{#each markers as mk}
				{@const i = idx(mk.date)}
				{#if i >= 0}
					<line x1={x(i)} x2={x(i)} y1={pad.t} y2={pad.t + innerH} stroke={mk.color ?? 'var(--warn)'} stroke-dasharray="3 3" opacity="0.8" />
					<circle cx={x(i)} cy={pad.t + 3} r="4" fill={mk.color ?? 'var(--warn)'}><title>{mk.date}: {mk.label}</title></circle>
				{/if}
			{/each}
			{#each anomalies as an}
				{@const i = idx(an.date)}
				{#if i >= 0}
					<rect x={x(i) - 3} y={pad.t} width="6" height={innerH} fill={an.direction === 'drop' ? 'var(--bad)' : 'var(--good)'} opacity="0.14" />
				{/if}
			{/each}
			{#each paths as p}
				<path d={p.d} fill="none" stroke={p.color} stroke-width="1.75" stroke-linejoin="round" />
			{/each}
			{#each ticks as t}
				<text x={x(t)} y={height - 6} font-size="11" fill="var(--muted)" text-anchor={t === 0 ? 'start' : t === data.length - 1 ? 'end' : 'middle'}>{data[t].date.slice(5)}</text>
			{/each}
			{#if hover !== null}
				<line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + innerH} stroke="var(--muted)" opacity="0.5" />
			{/if}
		</svg>
		{#if hover !== null}
			{@const p = data[hover]}
			<div
				class="card pointer-events-none absolute top-8 z-10 px-3 py-2 text-xs shadow-sm tnum"
				style="left:{Math.min(Math.max(x(hover) - 70, 0), width - 160)}px"
			>
				<div class="mb-1 font-medium">{p.date}</div>
				{#each METRICS.filter((m) => on.includes(m.key)) as m}
					<div style="color:{m.color}">{m.label} {m.key === 'position' ? fmtPos(p[m.key]) : fmtInt(p[m.key])}</div>
				{/each}
			</div>
		{/if}
	{/if}
</div>
