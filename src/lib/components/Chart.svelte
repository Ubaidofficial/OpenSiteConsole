<script lang="ts">
	import { untrack } from 'svelte';
	import { fmtCompact, fmtInt, fmtPos } from '$lib/format';

	/**
	 * The traffic chart, as small multiples: one panel per measure, each on its own real axis with readable tick values, all sharing
	 * the date axis, the markers and one hover crosshair. (One plot with every series scaled to its own hidden range made the lines'
	 * crossings meaningless and left the axis numbers true for one series only.) Position runs top-down, 1 at the top.
	 */
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
		/** height of the whole chart when one measure is shown; with more, each panel gets a share of a little more room */
		height?: number;
		defaultMetrics?: string[];
		/** Rename a series, e.g. { clicks: 'GA4 organic sessions' } */
		labels?: Partial<Record<Key, string>>;
		hide?: Key[];
		/** The last N days are provisional (Search Console revises them) and drawn dashed. */
		dashed?: number;
	} = $props();

	const BASE: { key: Key; label: string; color: string }[] = [
		{ key: 'clicks', label: 'Clicks', color: 'var(--c-clicks)' },
		{ key: 'impressions', label: 'Impressions', color: 'var(--c-impr)' },
		{ key: 'position', label: 'Avg position', color: 'var(--c-pos)' }
	];
	const METRICS = $derived(BASE.filter((m) => !hide.includes(m.key)).map((m) => ({ ...m, label: labels[m.key] ?? m.label })));

	let on = $state<string[]>(untrack(() => [...defaultMetrics]));
	let width = $state(800);
	let hover = $state<number | null>(null);

	const active = $derived(METRICS.filter((m) => on.includes(m.key)));
	const panelH = $derived(active.length <= 1 ? height : Math.max(104, Math.round(height * 0.52)));
	const pad = { l: 46, r: 12, t: 10, b: 8 };
	const axisH = 22; // the date labels, under the last panel only
	const innerW = $derived(Math.max(10, width - pad.l - pad.r));
	const innerH = $derived(panelH - pad.t - pad.b);
	const x = (i: number) => pad.l + (data.length <= 1 ? innerW / 2 : (i / (data.length - 1)) * innerW);

	/** Round tick values: 0 and two or three steps of 1, 2 or 5 times a power of ten. */
	function niceTicks(lo: number, hi: number, count = 3): number[] {
		const span = Math.max(1e-9, hi - lo);
		const raw = span / count;
		const mag = 10 ** Math.floor(Math.log10(raw));
		const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
		const out: number[] = [];
		// always end on the first round value at or above the data's maximum, so no line runs past the top of its panel
		for (let v = Math.floor(lo / step) * step; v < hi + step - 1e-9; v += step) out.push(Math.round(v * 1000) / 1000);
		return out;
	}

	const panels = $derived(
		active.map((m) => {
			const pos = m.key === 'position';
			const vals = data.map((d) => d[m.key]).filter((v) => !pos || v > 0);
			// volume starts at 0; position spans its own range with a little air, 1 at the top
			const lo = pos ? Math.max(1, Math.floor(Math.min(...vals, 99) - 0.5)) : 0;
			const ticks = pos ? niceTicks(lo, Math.ceil(Math.max(...vals, lo + 1) + 0.5)) : niceTicks(0, Math.max(1, ...vals));
			const hi = Math.max(ticks[ticks.length - 1] ?? 1, pos ? lo + 1 : 1);
			const y = (v: number) => pad.t + (pos ? (v - lo) / (hi - lo) : 1 - v / hi) * innerH;
			const cut = Math.max(1, data.length - dashed);
			let solid = '';
			let tail = '';
			let pen = false;
			data.forEach((p, i) => {
				if (pos && !p.position) {
					pen = false;
					return;
				}
				const seg = `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[m.key]).toFixed(1)}`;
				if (i <= cut) solid += seg;
				else tail += (i === cut + 1 ? `M${x(cut).toFixed(1)},${y(data[cut][m.key]).toFixed(1)}` : '') + `L${x(i).toFixed(1)},${y(p[m.key]).toFixed(1)}`;
				pen = true;
			});
			const outline = data.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[m.key]).toFixed(1)}`).join('');
			const area = pos || data.length < 2 ? '' : `${outline}L${x(data.length - 1).toFixed(1)},${pad.t + innerH}L${x(0).toFixed(1)},${pad.t + innerH}Z`;
			return { ...m, pos, ticks: ticks.filter((t) => t >= lo && t <= hi + 1e-9), y, solid, tail, area };
		})
	);

	const idx = (date: string) => data.findIndex((d) => d.date === date);
	const ticksX = $derived(data.length ? [...new Set([0, 0.2, 0.4, 0.6, 0.8, 1].map((t) => Math.round(t * (data.length - 1))))] : []);
	const fmtDay = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
	const fmtLong = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
	const fmtTick = (k: Key, v: number) => (k === 'position' ? String(v) : fmtCompact(Math.round(v)));
	const fmtVal = (k: Key, p: Point) => (k === 'position' ? (p.position ? fmtPos(p.position) : '–') : fmtInt(p[k]));

	function move(e: PointerEvent) {
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const rel = (e.clientX - r.left - pad.l) / innerW;
		hover = Math.min(data.length - 1, Math.max(0, Math.round(rel * (data.length - 1))));
	}
	const tipLeft = $derived(hover === null ? 0 : x(hover) > width * 0.6 ? Math.max(4, x(hover) - 196) : Math.min(x(hover) + 14, width - 190));
	const summary = $derived(
		data.length
			? `${active.map((m) => m.label).join(', ')} by day, ${fmtDay(data[0].date)} to ${fmtDay(data[data.length - 1].date)}. ` +
				active.map((m) => (m.key === 'position' ? `${m.label} latest ${fmtVal(m.key, data[data.length - 1])}` : `${m.label} total ${fmtInt(data.reduce((a, p) => a + p[m.key], 0))}`)).join('; ')
			: 'No data'
	);
</script>

<div class="relative" bind:clientWidth={width}>
	<div class="mb-3 flex flex-wrap gap-1.5" role="group" aria-label="Measures shown">
		{#each METRICS as m}
			{@const isOn = on.includes(m.key)}
			<button
				class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors {isOn ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent/60'}"
				aria-pressed={isOn}
				onclick={() => (on = on.includes(m.key) ? (on.length > 1 ? on.filter((k) => k !== m.key) : on) : [...on, m.key])}
			>
				<span class="size-2 rounded-full transition-opacity" style="background:{m.color};opacity:{isOn ? 1 : 0.3}"></span>{m.label}
			</button>
		{/each}
	</div>

	{#if data.length === 0}
		<div class="flex items-center justify-center text-muted-foreground" style="height:{height}px">No data in this period yet</div>
	{:else}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="reveal-x touch-none select-none" role="img" aria-label={summary} onpointermove={move} onpointerleave={() => (hover = null)}>
			{#each panels as s, k (s.key)}
				{@const last = k === panels.length - 1}
				<svg {width} height={panelH + (last ? axisH : 0)} class="block" aria-hidden="true">
					{#each s.ticks as t}
						<line x1={pad.l} x2={width - pad.r} y1={s.y(t)} y2={s.y(t)} stroke="var(--grid)" stroke-width="1" />
						<text x={pad.l - 8} y={s.y(t) + 3.5} font-size="10.5" fill="var(--muted-foreground)" text-anchor="end" class="tnum">{fmtTick(s.key, t)}</text>
					{/each}
					{#each anomalies as an}
						{@const i = idx(an.date)}
						{#if i >= 0}<rect x={x(i) - 4} y={pad.t} width="8" height={innerH} rx="3" fill={an.direction === 'drop' ? 'var(--bad)' : 'var(--good)'} opacity="0.13" />{/if}
					{/each}
					{#each markers as mk}
						{@const i = idx(mk.date)}
						{#if i >= 0}
							<line x1={x(i)} x2={x(i)} y1={pad.t} y2={pad.t + innerH} stroke={mk.color ?? 'var(--warn)'} stroke-width="1" opacity="0.6" />
							{#if k === 0}<circle cx={x(i)} cy={pad.t + 4} r="4.5" fill={mk.color ?? 'var(--warn)'} stroke="var(--card)" stroke-width="2"><title>{mk.date}: {mk.label}</title></circle>{/if}
						{/if}
					{/each}
					{#if s.area}<path d={s.area} fill={s.color} opacity="0.1" />{/if}
					<path d={s.solid} fill="none" stroke={s.color} stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
					{#if s.tail}<path d={s.tail} fill="none" stroke={s.color} stroke-width="2" stroke-dasharray="3 4" stroke-linecap="round" opacity="0.7" />{/if}
					<!-- the panel's name, top left, so each axis says what it measures -->
					<text x={pad.l + 6} y={pad.t + 12} font-size="11" font-weight="600" fill="var(--foreground)" paint-order="stroke" stroke="var(--card)" stroke-width="3">{s.label}{s.pos ? ' (1 = top)' : ''}</text>
					{#if hover !== null && (!s.pos || data[hover].position)}
						<line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + innerH} stroke="var(--muted-foreground)" stroke-width="1" opacity="0.45" />
						<circle cx={x(hover)} cy={s.y(data[hover][s.key])} r="4" fill={s.color} stroke="var(--card)" stroke-width="2" />
					{/if}
					{#if last}
						<line x1={pad.l} x2={width - pad.r} y1={pad.t + innerH} y2={pad.t + innerH} stroke="var(--axis)" stroke-width="1" />
						{#each ticksX as t}
							<text x={x(t)} y={panelH + axisH - 8} font-size="10.5" fill="var(--muted-foreground)" text-anchor={t === 0 ? 'start' : t === data.length - 1 ? 'end' : 'middle'}>{fmtDay(data[t].date)}</text>
						{/each}
					{/if}
				</svg>
			{/each}
		</div>

		{#if hover !== null}
			{@const p = data[hover]}
			<div class="pointer-events-none absolute z-10 rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md" style="top:44px;left:{tipLeft}px;min-width:10.5rem">
				<div class="mb-1.5 font-medium">{fmtLong(p.date)}{#if hover >= data.length - dashed}<span class="ml-1 font-normal text-muted-foreground">· provisional</span>{/if}</div>
				{#each active as m}
					<div class="flex items-center justify-between gap-4 tnum">
						<span class="inline-flex items-center gap-1.5 text-muted-foreground"><span class="size-2 rounded-full" style="background:{m.color}"></span>{m.label}</span>
						<span class="font-medium text-foreground">{fmtVal(m.key, p)}</span>
					</div>
				{/each}
			</div>
		{/if}
	{/if}
</div>
