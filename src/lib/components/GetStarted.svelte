<script lang="ts">
	import { enhance } from '$app/forms';
	import { toast } from 'svelte-sonner';
	import { Bell, Bot, Cable, ChevronDown, ChevronRight, Check, Copy, ListChecks, Plug, RefreshCw, ScanSearch, Tag, TriangleAlert, Users } from '@lucide/svelte';
	import type { OnboardingStep, StepId } from '$lib/onboarding';

	let { steps, progress }: { steps: OnboardingStep[]; progress: { done: number; total: number; complete: boolean; next: OnboardingStep | null } } = $props();
	const ICON: Record<StepId, typeof Plug> = { google: Plug, sync: RefreshCw, actions: ListChecks, sources: Cable, indexing: ScanSearch, brand: Tag, alerts: Bell, agent: Bot, team: Users };
	const open = $derived(steps.filter((s) => !s.done));
	const done = $derived(steps.filter((s) => s.done));
	/** The next step starts unfolded, like a checklist that points at what to do now. */
	let expanded = $state<string | null>(null);
	$effect(() => {
		if (expanded === null && progress.next) expanded = progress.next.id;
	});
	let showDone = $state(false);
	const copy = (t: string) => navigator.clipboard?.writeText(t).then(() => toast.success('Copied'), () => toast.error('Could not copy'));
</script>

<section class="card mb-6 overflow-hidden" aria-labelledby="gs-h">
	<div class="flex flex-wrap items-start gap-3 border-b p-4 sm:p-5" style="border-color:var(--border)">
		<div class="min-w-0 flex-1">
			<h2 id="gs-h" class="text-base font-semibold">{progress.complete ? 'You are set up' : 'Get started'}</h2>
			<p class="text-sm text-muted-foreground">{progress.complete ? 'Every step is done. Hide this guide, or keep it for the optional ones.' : 'Connect your data, then let it tell you what to fix first.'}</p>
		</div>
		<div class="flex items-center gap-3">
			<div class="flex items-center gap-2 text-xs text-muted-foreground" title="Required steps done">
				<div class="h-1.5 w-24 overflow-hidden rounded-full bg-muted"><div class="h-full rounded-full bg-[color:var(--good)]" style="width:{Math.round((progress.done / progress.total) * 100)}%"></div></div>
				<span class="tnum">{progress.done} of {progress.total}</span>
			</div>
			<form method="POST" action="?/hideOnboarding" use:enhance><button class="btn !h-8 text-xs" title="Hide the guide; a link at the bottom of the dashboard brings it back">Hide</button></form>
		</div>
	</div>
	<ul>
		{#each open as s (s.id)}
			{@const Icon = ICON[s.id]}
			<li class="border-b last:border-b-0" style="border-color:var(--border)">
				<button type="button" class="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/40 sm:px-5" aria-expanded={expanded === s.id} onclick={() => (expanded = expanded === s.id ? '' : s.id)}>
					<span class="grid size-8 shrink-0 place-items-center rounded-lg border bg-background"><Icon class="size-4" /></span>
					<span class="min-w-0 flex-1">
						<span class="flex flex-wrap items-center gap-2 text-sm font-medium">{s.title}{#if s.optional}<span class="chip text-[11px]">optional</span>{/if}{#if s.blocked}<span class="chip border-[color:var(--warn)] text-[11px] text-warn">setup required</span>{/if}</span>
						<span class="block text-xs text-muted-foreground">{s.blurb}</span>
					</span>
					<ChevronDown class="size-4 shrink-0 text-muted-foreground transition-transform {expanded === s.id ? 'rotate-180' : ''}" />
				</button>
				{#if expanded === s.id}
					<div class="px-4 pb-4 sm:pl-16 sm:pr-5">
						{#if s.blocked}<p class="mb-2 flex gap-2 rounded-lg border border-[color:var(--warn)] bg-[color:var(--warn)]/10 p-2 text-xs"><TriangleAlert class="size-4 shrink-0 text-warn" />{s.blocked}</p>{/if}
						{#if s.status}<p class="mb-2 text-xs text-muted-foreground">{s.status}</p>{/if}
						{#if s.href}<a class="btn btn-primary !h-8 text-xs" href={s.href}>{s.cta}</a>{/if}
						{#if s.agentPrompt}
							<p class="mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-muted/50 px-3 py-2 text-xs"><span class="text-muted-foreground">Or ask your agent:</span> <span>“{s.agentPrompt}”</span><button type="button" class="text-muted-foreground hover:text-foreground" aria-label="Copy the prompt" onclick={() => copy(s.agentPrompt!)}><Copy class="size-3.5" /></button></p>
						{/if}
					</div>
				{/if}
			</li>
		{/each}
		{#if done.length}
			<li>
				<button type="button" class="flex w-full items-center gap-2 px-4 py-3 text-left text-sm hover:bg-muted/40 sm:px-5" aria-expanded={showDone} onclick={() => (showDone = !showDone)}>
					<Check class="size-4 text-good" /><span>{done.length} completed</span><ChevronRight class="ml-auto size-4 text-muted-foreground transition-transform {showDone ? 'rotate-90' : ''}" />
				</button>
				{#if showDone}
					<ul class="px-4 pb-3 sm:px-5">{#each done as s (s.id)}<li class="flex items-center gap-2 py-1 text-xs text-muted-foreground"><Check class="size-3.5 text-good" /><span class="text-foreground">{s.title}</span>{#if s.status}<span>· {s.status}</span>{/if}{#if s.href}<a class="ml-auto hover:underline" href={s.href}>{s.cta}</a>{/if}</li>{/each}</ul>
				{/if}
			</li>
		{/if}
	</ul>
</section>
