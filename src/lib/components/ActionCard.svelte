<script lang="ts">
	import { enhance } from '$app/forms';
	import { NAMES_TARGETS, type ActionItem } from '$lib/actions';
	import { Tip } from '$lib/components/ui/tooltip';
	import { BLOCKING_EXPLAIN, BUTTON_EXPLAIN, CONFIDENCE_EXPLAIN, EFFORT_EXPLAIN, IMPACT_EXPLAIN, NO_IMPACT_EXPLAIN, TYPE_EXPLAIN, TYPE_LABEL } from '$lib/explain';
	let { a, rank, site = null, siteHref = null, hideControls = false, restore = false }: { a: ActionItem & { score?: number; site?: string }; rank: number; site?: string | null; siteHref?: string | null; hideControls?: boolean; restore?: boolean } = $props();
	const names = $derived(NAMES_TARGETS.has(a.type));
	const conf = { high: 'text-good', medium: 'text-muted-foreground', low: 'text-warn' } as const;
</script>

<article class="card p-4 {a.blocking ? 'border-[color:var(--bad)]' : ''}">
	<div class="flex flex-wrap items-center gap-2 text-xs">
		<span class="tnum grid size-6 place-items-center rounded-full bg-muted font-semibold">{rank}</span>
		{#if a.blocking}<Tip text={BLOCKING_EXPLAIN}><span class="chip border-[color:var(--bad)] text-bad">Do first: blocking</span></Tip>{/if}
		<Tip text={TYPE_EXPLAIN[a.type]}><span class="chip">{TYPE_LABEL[a.type]}</span></Tip>
		{#if site}<a class="chip pii" href={siteHref ?? '#'}>{site}</a>{/if}
		{#if a.impact != null}<Tip text={IMPACT_EXPLAIN}><span class="chip">≈ {Math.round(a.impact).toLocaleString('en-US')} clicks / 28d</span></Tip>{:else}<Tip text={NO_IMPACT_EXPLAIN}><span class="chip">no click estimate</span></Tip>{/if}
		<Tip text={CONFIDENCE_EXPLAIN[a.confidence]}><span class="chip {conf[a.confidence]}">{a.confidence} confidence</span></Tip>
		<Tip text={EFFORT_EXPLAIN[a.effort]}><span class="chip">{a.effort} effort</span></Tip>
	</div>
	<h3 class="mt-2 font-medium" class:pii={names}>{a.title}</h3>
	<p class="mt-1 text-sm text-muted-foreground" class:pii={names}>{a.why}</p>
	<p class="mt-1.5 text-sm" class:pii={names}><b>What to do:</b> {a.how}</p>
	{#if a.evidence.length}<ul class="pii mt-2 space-y-0.5 text-xs text-muted-foreground">{#each a.evidence as e}<li>· {e}</li>{/each}</ul>{/if}
	<div class="mt-3 flex flex-wrap items-center gap-2">
		<Tip interactive text={BUTTON_EXPLAIN.open}><a class="btn !h-8 text-xs" href={a.href}>Open</a></Tip>
		{#if !hideControls}
			<form method="POST" action="/sites/{a.siteId}/actions?/state" use:enhance class="flex gap-2">
				<input type="hidden" name="key" value={a.key} />
				{#if restore}<Tip interactive text={BUTTON_EXPLAIN.restore}><button class="btn !h-8 text-xs" name="state" value="open">Restore</button></Tip>
				{:else}<Tip interactive text={BUTTON_EXPLAIN.done}><button class="btn !h-8 text-xs" name="state" value="done">Done</button></Tip><Tip interactive text={BUTTON_EXPLAIN.snooze}><button class="btn !h-8 text-xs" name="state" value="snoozed">Snooze 30d</button></Tip>{/if}
			</form>
		{/if}
	</div>
</article>
