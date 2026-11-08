<script lang="ts">
	/**
	 * Pages x weeks, shaded by clicks, each row scaled to that page's own best week: a page sliding slowly shows as a row fading
	 * towards the right, whatever its size. One hue, light (few clicks) to full (its best week), with a scale legend; hover or focus a
	 * cell for the exact number. Pages flagged as decaying are marked.
	 */
	let { weeks, rows }: { weeks: string[]; rows: { page: string; flagged: boolean; clicks: number[] }[] } = $props();
	const pathOf = (u: string) => { try { return new URL(u).pathname; } catch { return u; } };
	const fmt = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
	const sorted = $derived([...rows].filter((r) => Math.max(...r.clicks) > 0).sort((a, b) => Number(b.flagged) - Number(a.flagged) || b.clicks.reduce((x, y) => x + y, 0) - a.clicks.reduce((x, y) => x + y, 0)));
	const shade = (v: number, max: number) => `color-mix(in oklab, var(--chart-1) ${max ? Math.round(6 + (v / max) * 94) : 0}%, var(--card))`;
	let hover = $state<{ r: number; w: number } | null>(null);
</script>

{#if rows.length && weeks.length}
	<div class="overflow-x-auto">
		<table class="w-full min-w-[40rem] table-fixed border-separate border-spacing-[2px] text-xs" aria-label="Weekly clicks for the biggest pages, each row against its own best week">
			<thead>
				<tr>
					<th class="w-[34%] pb-1 text-left font-normal text-muted-foreground">Page</th>
					{#each weeks as w, i}<th class="pb-1 font-normal text-muted-foreground">{#if i === 0 || i === weeks.length - 1 || i === Math.floor(weeks.length / 2)}<span class="relative whitespace-nowrap">{fmt(w)}</span>{/if}</th>{/each}
				</tr>
			</thead>
			<tbody>
				{#each sorted as r, ri (r.page)}
					{@const max = Math.max(...r.clicks)}
					<tr>
						<th scope="row" class="max-w-0 truncate pr-2 text-left font-normal">
							<a href={r.page} target="_blank" rel="noreferrer noopener" class="pii hover:underline" title={r.page}>{pathOf(r.page)}</a>
							{#if r.flagged}<span class="ml-1 rounded border border-[color:var(--bad)] px-1 text-[10px] text-bad">decaying</span>{/if}
						</th>
						{#each r.clicks as c, wi}
							<td class="h-5 rounded-[3px] p-0 {hover && hover.r === ri && hover.w === wi ? 'ring-2 ring-[color:var(--foreground)]' : ''}" style="background:{shade(c, max)}"
								title="{pathOf(r.page)}, week of {fmt(weeks[wi])}: {c.toLocaleString('en-US')} clicks" onpointerenter={() => (hover = { r: ri, w: wi })} onpointerleave={() => (hover = null)}>
								<span class="sr-only">{c} clicks</span>
							</td>
						{/each}
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
	<div class="mt-2 flex items-center gap-2 text-xs text-muted-foreground" aria-hidden="true">
		<span>fewer clicks</span>
		<span class="h-2 w-28 rounded-full" style="background:linear-gradient(90deg, color-mix(in oklab, var(--chart-1) 6%, var(--card)), var(--chart-1))"></span>
		<span>that page's best week</span>
		{#if hover}<span class="ml-auto tnum text-foreground">{pathOf(sorted[hover.r].page)} · week of {fmt(weeks[hover.w])}: <b>{sorted[hover.r].clicks[hover.w].toLocaleString('en-US')}</b> clicks</span>{/if}
	</div>
{/if}
