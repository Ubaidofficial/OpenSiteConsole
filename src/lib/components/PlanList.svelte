<script lang="ts">
	import { enhance } from '$app/forms';
	import { Check } from '@lucide/svelte';
	import { NAMES_TARGETS, type ActionItem } from '$lib/actions';
	import { TYPE_LABEL } from '$lib/explain';
	import { firstStep } from '$lib/plan';
	import { fmtInt } from '$lib/format';

	/** One section of the two-week plan: a numbered list of compact rows, each with its first step, its estimate and a Done button. */
	let { items, start = 1, tone = 'default', max = null }: { items: ActionItem[]; start?: number; tone?: 'default' | 'bad'; /** the largest estimate across the whole plan, so every row's bar shares one scale */ max?: number | null } = $props();
	const effortWord = { low: 'quick fix', medium: 'a few hours', high: 'a project' } as const;
	/** The number of an earlier row with the very same first step, so it is said once and pointed to after that. */
	const sameAs = $derived.by(() => {
		const first = new Map<string, number>();
		return items.map((a, i) => {
			const step = firstStep(a.how);
			const at = first.get(step);
			if (at == null) first.set(step, start + i);
			return at ?? null;
		});
	});
</script>

<ol class="divide-y overflow-hidden rounded-xl border bg-card shadow-xs {tone === 'bad' ? 'border-[color:var(--bad)]' : ''}">
	{#each items as a, i (a.key)}
		{@const names = NAMES_TARGETS.has(a.type)}
		<li class="flex items-start gap-3 px-4 py-3">
			<form method="POST" action="/sites/{a.siteId}/actions?/state" use:enhance class="pt-0.5">
				<input type="hidden" name="key" value={a.key} />
				<button name="state" value="done" class="group grid size-6 place-items-center rounded-full border text-muted-foreground transition-colors hover:border-[color:var(--good)] hover:bg-good/10 hover:text-good" title="Mark done: hidden for 90 days, and it comes back if the problem is still there" aria-label="Mark “{a.title}” done">
					<Check class="size-3.5 opacity-40 group-hover:opacity-100" />
				</button>
			</form>
			<div class="min-w-0 flex-1">
				<div class="flex flex-wrap items-baseline gap-x-2">
					<span class="tnum text-xs text-muted-foreground">{start + i}.</span>
					<a href={a.href} class="font-medium hover:underline" class:pii={names}>{a.title}</a>
				</div>
				<p class="mt-0.5 text-sm text-muted-foreground" class:pii={names}>{sameAs[i] ? `Same fix as #${sameAs[i]}.` : firstStep(a.how)}</p>
			</div>
			<div class="shrink-0 text-right text-xs">
				{#if a.impact != null}<div class="tnum font-semibold whitespace-nowrap text-foreground" title="Estimated extra clicks per 28 days, from this site's own click curve">≈ {fmtInt(Math.round(a.impact))} clicks / 28d</div>
				{#if max}<div class="mt-1 ml-auto h-1.5 w-24 rounded-full bg-muted" aria-hidden="true"><div class="ml-auto h-1.5 rounded-full" style="width:{Math.max(4, (a.impact / max) * 100)}%; background:var(--chart-1)"></div></div>{/if}
				{:else}<div class="text-muted-foreground">{TYPE_LABEL[a.type]}</div>{/if}
				<div class="mt-0.5 text-muted-foreground">{effortWord[a.effort]}</div>
			</div>
		</li>
	{/each}
</ol>
