<script lang="ts">
	import { enhance } from '$app/forms';
	import { toast } from 'svelte-sonner';
	import { AlertTriangle, ArrowRight, Bell, Bot, Cable, Check, Copy, ListChecks, LoaderCircle, Plug, RefreshCw, ScanSearch, Sparkles, Tag, Users } from '@lucide/svelte';
	import { PHASES, type OnboardingStep, type StepId } from '$lib/onboarding';

	let { steps, progress, running }: {
		steps: OnboardingStep[];
		progress: { done: number; total: number; complete: boolean; next: OnboardingStep | null; minutesLeft: number };
		running: string[];
	} = $props();

	const ICON: Record<StepId, typeof Plug> = { google: Plug, sync: RefreshCw, sources: Cable, actions: ListChecks, indexing: ScanSearch, brand: Tag, alerts: Bell, agent: Bot, team: Users };
	/** The step in the panel: the next one to do, unless the person picked another in the list. */
	let picked = $state<StepId | null>(null);
	const current = $derived(steps.find((s) => s.id === picked) ?? progress.next ?? steps[0]);
	const index = $derived(steps.indexOf(current));
	const CurrentIcon = $derived(ICON[current.id]);
	const nextAfter = $derived(steps.slice(index + 1).find((s) => !s.done) ?? steps.find((s) => !s.done && s.id !== current.id) ?? null);
	let reviewing = $state(false);
	let busy = $state(false);

	// Progress ring: required steps done.
	const R = 18, C = 2 * Math.PI * R;
	const frac = $derived(progress.total ? progress.done / progress.total : 0);

	const copy = (value: string, what: string) => navigator.clipboard?.writeText(value).then(() => toast.success(`${what} copied`), () => toast.error('Could not copy'));
	const stateOf = (s: OnboardingStep) => (s.done ? 'done' : s.blocked ? 'blocked' : s.id === progress.next?.id ? 'next' : 'todo');
</script>

<section class="card mb-6 overflow-hidden" aria-labelledby="gs-h">
	<header class="flex flex-wrap items-center gap-x-4 gap-y-2 p-4 sm:px-5">
		<svg viewBox="0 0 44 44" class="size-11 shrink-0 -rotate-90" role="img" aria-label="{progress.done} of {progress.total} steps done">
			<circle cx="22" cy="22" r={R} fill="none" stroke="var(--border)" stroke-width="4" />
			<circle cx="22" cy="22" r={R} fill="none" stroke="var(--good)" stroke-width="4" stroke-linecap="round" stroke-dasharray={C} stroke-dashoffset={C * (1 - frac)} class="transition-[stroke-dashoffset] duration-500 motion-reduce:transition-none" />
			<text x="22" y="22" transform="rotate(90 22 22)" text-anchor="middle" dominant-baseline="central" class="fill-foreground text-[11px] font-semibold tnum">{progress.done}/{progress.total}</text>
		</svg>
		<div class="min-w-0 flex-1">
			<h2 id="gs-h" class="text-base font-semibold tracking-tight">{progress.complete ? 'SEOConsole is set up' : 'Set up SEOConsole'}</h2>
			<p class="text-sm text-muted-foreground">
				{#if progress.complete}Everything that needs you is done; the rest runs by itself.
				{:else}{progress.total - progress.done} step{progress.total - progress.done === 1 ? '' : 's'} left{progress.minutesLeft ? `, about ${progress.minutesLeft} minutes` : ''}. Each one ticks itself off when it is done.{/if}
			</p>
		</div>
		{#if progress.complete}<button type="button" class="btn !h-8 text-xs" aria-expanded={reviewing} onclick={() => (reviewing = !reviewing)}>{reviewing ? 'Close' : 'Review steps'}</button>{/if}
		<form method="POST" action="?/hideOnboarding" use:enhance><button class="btn !h-8 text-xs" title="Hide the guide. “Set-up guide” at the bottom of the dashboard brings it back.">Hide</button></form>
	</header>

	{#if progress.complete && !reviewing}
		{#if running.length}
			<ul class="flex flex-wrap gap-2 border-t px-4 py-3 text-xs sm:px-5" style="border-color:var(--border)" aria-label="What is running">
				{#each running as r}<li class="chip gap-1.5"><Check class="size-3 text-good" />{r}</li>{/each}
			</ul>
		{/if}
	{:else}
		<div class="grid border-t lg:grid-cols-[minmax(0,1fr)_19rem]" style="border-color:var(--border)">
			<!-- the step in focus -->
			<div class="flex min-w-0 flex-col p-4 sm:p-5" aria-live="polite">
				<p class="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
					<span class="font-medium text-foreground">{PHASES.find((p) => p.id === current.phase)?.label}</span>
					<span aria-hidden="true">·</span><span>Step {index + 1} of {steps.length}</span>
					{#if current.minutes}<span aria-hidden="true">·</span><span>about {current.minutes} min</span>{:else if !current.done}<span aria-hidden="true">·</span><span>runs by itself</span>{/if}
					{#if current.optional}<span class="chip text-[11px]">optional</span>{/if}
					{#if current.id === progress.next?.id && !current.done}<span class="chip chip-on text-[11px]">up next</span>{/if}
				</p>
				<div class="flex items-start gap-3">
					<span class="grid size-10 shrink-0 place-items-center rounded-xl border {current.done ? 'border-[color:var(--good)] text-good' : 'bg-background'}">{#if current.done}<Check class="size-5" />{:else}<CurrentIcon class="size-5" />{/if}</span>
					<div class="min-w-0 flex-1">
						<h3 class="text-lg leading-snug font-semibold tracking-tight">{current.title}</h3>
						<p class="pii mt-1 max-w-2xl text-sm text-muted-foreground">{current.impact}</p>
					</div>
				</div>

				{#if current.blocked}
					<p class="mt-3 flex gap-2 rounded-xl border border-[color:var(--warn)] bg-[color:var(--warn)]/10 p-3 text-sm"><AlertTriangle class="mt-0.5 size-4 shrink-0 text-warn" /><span><b class="font-medium">Setup required.</b> {current.blocked}</span></p>
				{/if}
				{#if current.progress != null && !(current.done && current.progress >= 1)}
					<div class="mt-3 h-1.5 max-w-sm overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(current.progress * 100)} aria-label={current.status ?? 'Progress'}><div class="h-full rounded-full bg-[color:var(--good)] transition-[width] duration-500 motion-reduce:transition-none" style="width:{Math.round(current.progress * 100)}%"></div></div>
				{/if}
				{#if current.status}<p class="mt-2 flex items-center gap-1.5 text-xs {current.done ? 'text-good' : 'text-muted-foreground'}">{#if current.done}<Check class="size-3.5" />{/if}{current.status}</p>{/if}

				<!-- keyed per step: reusing the previous step's buttons would fade a black primary button into a white one -->
				{#key current.id}
				<div class="mt-4 flex flex-wrap items-center gap-2">
					{#if current.inline && !current.done}
						{#if current.inline.kind === 'form'}
							{@const inl = current.inline}
							<form method="POST" action="?/{inl.action}" use:enhance={() => { busy = true; return async ({ update }) => { await update(); busy = false; picked = null; }; }}>
								{#each Object.entries(inl.fields) as [k, v]}<input type="hidden" name={k} value={v} />{/each}
								<button class="btn btn-primary" disabled={busy}>{#if busy}<LoaderCircle class="size-4 animate-spin" />{/if}<span class="pii">{inl.label}</span></button>
							</form>
						{:else}
							{@const inl = current.inline}
							<button type="button" class="btn btn-primary" onclick={() => copy(inl.value, inl.label.replace(/^Copy the /, '').replace(/^./, (c) => c.toUpperCase()))}><Copy class="size-4" />{inl.label}</button>
							<code class="pii max-w-full truncate rounded-md bg-muted px-2 py-1 text-xs">{inl.value}</code>
						{/if}
					{/if}
					{#if current.href}<a class="btn {current.inline && !current.done ? '' : current.done ? '' : 'btn-primary'}" href={current.href}>{current.cta}{#if !current.inline || current.done}<ArrowRight class="size-4" />{/if}</a>{/if}
					{#if current.done && nextAfter}<button type="button" class="btn btn-primary" onclick={() => (picked = nextAfter.id)}>Next: {nextAfter.title}<ArrowRight class="size-4" /></button>{/if}
				</div>
				{/key}

				{#if current.agentPrompt && !current.done}
					<div class="mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-dashed px-3 py-2 text-xs" style="border-color:var(--border)">
						<Sparkles class="size-3.5 text-muted-foreground" /><span class="text-muted-foreground">Your agent is connected. Ask it:</span>
						<span class="font-medium">“{current.agentPrompt}”</span>
						<button type="button" class="ml-auto text-muted-foreground hover:text-foreground" aria-label="Copy the question" onclick={() => copy(current.agentPrompt!, 'Question')}><Copy class="size-3.5" /></button>
					</div>
				{/if}
				{#if nextAfter && !current.done}
					<div class="min-h-5 flex-1" aria-hidden="true"></div>
					<button type="button" onclick={() => (picked = nextAfter.id)} class="group flex flex-wrap items-center gap-x-2 gap-y-0.5 border-t pt-3 text-left text-xs text-muted-foreground hover:text-foreground" style="border-color:var(--border)">
						<span>After this</span><span aria-hidden="true">·</span><span class="font-medium text-foreground">{nextAfter.title}</span>{#if nextAfter.minutes}<span>({nextAfter.minutes} min)</span>{/if}<ArrowRight class="size-3.5 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" />
					</button>
				{/if}
			</div>

			<!-- every step, by phase -->
			<nav class="border-t bg-muted/30 p-3 lg:border-t-0 lg:border-l" style="border-color:var(--border)" aria-label="Set-up steps">
				<ol class="space-y-3">
					{#each PHASES as ph, pi (ph.id)}
						{@const list = steps.filter((s) => s.phase === ph.id)}
						{@const left = list.filter((s) => !s.done && !s.optional).length}
						<li>
							<p class="mb-1 flex items-baseline gap-2 px-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
								<span>{pi + 1}. {ph.label}</span><span class="font-normal normal-case tracking-normal">{ph.blurb}</span>
								{#if !left}<Check class="ml-auto size-3.5 text-good" aria-label="Phase done" />{/if}
							</p>
							<ol>
								{#each list as s (s.id)}
									{@const st = stateOf(s)}
									<li>
										<button type="button" onclick={() => (picked = s.id)} aria-current={s.id === current.id ? 'step' : undefined}
											class="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-background {s.id === current.id ? 'bg-background shadow-xs ring-1 ring-[color:var(--border)]' : ''}">
											{#if st === 'done'}<span class="grid size-5 shrink-0 place-items-center rounded-full bg-[color:var(--good)] text-white"><Check class="size-3" /></span>
											{:else if st === 'blocked'}<span class="grid size-5 shrink-0 place-items-center rounded-full border border-[color:var(--warn)] text-warn"><AlertTriangle class="size-3" /></span>
											{:else if st === 'next'}<span class="grid size-5 shrink-0 place-items-center rounded-full border-2 border-[color:var(--link)]"><span class="size-2 rounded-full bg-[color:var(--link)]"></span></span>
											{:else}<span class="size-5 shrink-0 rounded-full border-2" style="border-color:var(--border)"></span>{/if}
											<span class="min-w-0 flex-1 truncate {s.done ? 'text-muted-foreground' : ''}">{s.title}</span>
											<span class="shrink-0 text-[11px] text-muted-foreground tnum">{s.done ? '' : s.optional ? 'optional' : s.minutes ? `${s.minutes} min` : 'auto'}</span>
										</button>
									</li>
								{/each}
							</ol>
						</li>
					{/each}
				</ol>
			</nav>
		</div>
	{/if}
</section>
