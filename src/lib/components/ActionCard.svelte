<script lang="ts">
	import { enhance } from '$app/forms';
	import { NAMES_TARGETS, type ActionItem } from '$lib/actions';
	let { a, rank, site = null, siteHref = null, hideControls = false, restore = false }: { a: ActionItem & { score?: number; site?: string }; rank: number; site?: string | null; siteHref?: string | null; hideControls?: boolean; restore?: boolean } = $props();
	const typeLabel: Record<string, string> = { tracking: 'Measurement', blocked: 'Blocked', deindexed: 'De-indexed', sitewide: 'Site-wide', anomaly: 'Traffic drop', dead: 'Gone', 'not-indexed': 'Not indexed', update: 'Google update', cannibalization: 'Cannibalization', 'ctr-gap': 'CTR gap', decay: 'Decay', striking: 'Striking distance', onpage: 'On-page', sitemap: 'Sitemap', vitals: 'Web vitals', test: 'Test' };
	const names = $derived(NAMES_TARGETS.has(a.type));
	const conf = { high: 'text-good', medium: 'text-muted-foreground', low: 'text-warn' } as const;
</script>

<article class="card p-4 {a.blocking ? 'border-[color:var(--bad)]' : ''}">
	<div class="flex flex-wrap items-center gap-2 text-xs">
		<span class="tnum grid size-6 place-items-center rounded-full bg-muted font-semibold">{rank}</span>
		{#if a.blocking}<span class="chip border-[color:var(--bad)] text-bad">Do first: blocking</span>{/if}
		<span class="chip">{typeLabel[a.type] ?? a.type}</span>
		{#if site}<a class="chip pii" href={siteHref ?? '#'}>{site}</a>{/if}
		{#if a.impact != null}<span class="chip" title="Estimated clicks per 28 days at stake or to gain, from this site's own data. A model figure, not a promise, and not additive across items.">≈ {Math.round(a.impact).toLocaleString('en-US')} clicks / 28 d</span>{:else}<span class="chip" title="No honest click estimate for this kind of item">no click estimate</span>{/if}
		<span class="chip {conf[a.confidence]}" title="How far to trust the estimate">{a.confidence} confidence</span>
		<span class="chip" title="Rough effort to act">{a.effort} effort</span>
	</div>
	<h3 class="mt-2 font-medium" class:pii={names}>{a.title}</h3>
	<p class="mt-1 text-sm text-muted-foreground" class:pii={names}>{a.why}</p>
	<p class="mt-1.5 text-sm" class:pii={names}><b>What to do:</b> {a.how}</p>
	{#if a.evidence.length}<ul class="pii mt-2 space-y-0.5 text-xs text-muted-foreground">{#each a.evidence as e}<li>· {e}</li>{/each}</ul>{/if}
	<div class="mt-3 flex flex-wrap items-center gap-2">
		<a class="btn !h-8 text-xs" href={a.href}>Open</a>
		{#if !hideControls}
			<form method="POST" action="/sites/{a.siteId}/actions?/state" use:enhance class="flex gap-2">
				<input type="hidden" name="key" value={a.key} />
				{#if restore}<button class="btn !h-8 text-xs" name="state" value="open">Restore</button>
				{:else}<button class="btn !h-8 text-xs" name="state" value="done">Done</button><button class="btn !h-8 text-xs" name="state" value="snoozed">Snooze 30 d</button>{/if}
			</form>
		{/if}
	</div>
</article>
