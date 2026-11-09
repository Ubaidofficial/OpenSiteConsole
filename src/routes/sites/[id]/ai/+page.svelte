<script lang="ts">
	import Explainer from '$lib/components/Explainer.svelte';
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { LoaderCircle, Play, Trash2 } from '@lucide/svelte';
	import { ago } from '$lib/format';
	import { ENGINE_LABEL } from '$lib/aivis';
	let { data, form } = $props();
	const r = $derived(data.report);
	const pct = (x: number) => `${Math.round(x * 100)}%`;
	const usd = (x: number, digits: number) => '$' + x.toFixed(digits);
	$effect(() => {
		if (!data.running) return;
		const t = setInterval(() => invalidateAll(), 4000);
		return () => clearInterval(t);
	});
</script>

<div class="mb-1 flex flex-wrap items-center gap-3">
	<h2 class="text-lg font-semibold">AI answers</h2>
	{#if r.demo}<span class="chip" title="Demo mode: the answers are made up, so the page has something to show">simulated answers</span>{/if}
	{#if r.engines.length && r.prompts.length}
		<form method="POST" action="?/run" use:enhance class="ml-auto"><button class="btn btn-primary" disabled={data.running}>{#if data.running}<LoaderCircle class="size-4 animate-spin" />Asking…{:else}<Play class="size-4" />Run now{/if}</button></form>
	{/if}
</div>
<Explainer lead="Ask AI assistants the questions your customers ask, and see whether they mention or cite you.">
	<p>Each prompt is put to every assistant you have set up (your own API keys, or DataForSEO), with web search on, every {r.limits.everyDays} days. The answer is checked for your brand or domain (a <b>mention</b>), for links to your pages among its sources (a <b>citation</b>, and its rank among the cited sites), and for the competitors you list. Answers vary from run to run and person to person, so read the rates over several runs, not a single answer. These are API answers: the consumer apps add personal context, so they are a consistent sample, not a copy of what each person sees.</p>
	<p>With <b>DataForSEO</b> (<code>DATAFORSEO_LOGIN</code>, <code>DATAFORSEO_PASSWORD</code>), ChatGPT and Gemini are asked in their real apps for the location you set, which is closer to what people see; Claude and Perplexity go through DataForSEO only when you have no key of your own for them (<code>AI_VIS_SOURCE</code> changes that).</p>
	<p>Every run is billed to your own accounts (tokens, plus each provider's search fee where it has one; DataForSEO per task), so runs are capped at {r.limits.runsPerDay} a day across all sites (<code>AI_VIS_RUNS_PER_DAY</code>); today {r.limits.runsToday} have run.</p>
</Explainer>
{#if form?.ok}<p class="mb-3 text-sm text-good">{form.ok}</p>{/if}{#if form?.error}<p class="mb-3 text-sm text-bad">{form.error}</p>{/if}

{#if !r.engines.length || !data.dataForSeo.set}
	<section class="card mb-4 p-4 text-sm">
		<h2 class="mb-1 font-medium">{r.engines.length ? 'How each assistant is asked' : 'Connect at least one assistant'}</h2>
		<p class="mb-2 text-xs text-muted-foreground">Set a key in <code>.env</code> and restart: an assistant's own API key, or one DataForSEO login for all four (ChatGPT and Gemini as seen in their apps). Nothing is asked until one is set.</p>
		<ul class="space-y-1 text-xs">{#each data.setup as s (s.engine)}<li><b>{ENGINE_LABEL[s.engine]}</b>: {#if s.route}<span class="text-good">{s.routeLabel}</span>{s.model ? ` · model ${s.model}` : ''}{:else}<span class="text-muted-foreground">not set up</span> ({s.keyEnv ? `${s.keyEnv} or ` : ''}DataForSEO){/if}</li>{/each}</ul>
	</section>
{:else}
	<p class="mb-3 text-xs text-muted-foreground">{#each data.setup.filter((x) => x.route) as s, i (s.engine)}{i ? ' · ' : ''}<b>{ENGINE_LABEL[s.engine]}</b>: {s.routeLabel}{/each} · DataForSEO location {data.dataForSeo.location.location_code}, language {data.dataForSeo.location.language_code}{#if r.reportedCost > 0} · DataForSEO cost, last {r.days} days: {usd(r.reportedCost, 2)}{/if}</p>
{/if}

{#if r.summary.runs}
	<div class="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
		{#each r.summary.byEngine as e (e.engine)}
			<div class="card p-3 text-sm">
				<div class="text-xs text-muted-foreground">{ENGINE_LABEL[e.engine]} · {e.runs} answer{e.runs === 1 ? '' : 's'}, last {r.days} days</div>
				<div class="mt-1 flex flex-wrap gap-x-4"><span title="Answers that name your brand or domain"><b class="tnum text-base">{pct(e.mentionRate)}</b> mention you</span><span title="Answers that cite one of your pages as a source"><b class="tnum text-base">{pct(e.citationRate)}</b> cite you</span></div>
				{#if e.avgPosition != null}<div class="mt-0.5 text-xs text-muted-foreground" title="Where your domain ranks among the cited sites, when cited (1 = first)">cited at rank {e.avgPosition.toFixed(1)} on average</div>{/if}
			</div>
		{/each}
	</div>
	<div class="mb-5 grid grid-cols-1 gap-4 lg:grid-cols-2">
		<section class="card p-3 text-sm">
			<h2 class="mb-1 font-medium">Share of voice</h2>
			<table class="w-full"><thead><tr><th class="th">Domain</th><th class="th text-right" title="Share of answers that name it">Mentioned</th><th class="th text-right" title="Share of answers that cite one of its pages">Cited</th></tr></thead>
				<tbody>{#each r.summary.voice as v (v.domain)}<tr><td class="td pii {v.ours ? 'font-medium' : ''}">{v.domain}{v.ours ? ' (you)' : ''}</td><td class="td tnum text-right">{pct(v.mentionShare)}</td><td class="td tnum text-right">{pct(v.citationShare)}</td></tr>{/each}</tbody></table>
			{#if !r.competitors.length}<p class="mt-2 text-xs text-muted-foreground">Add competitors below to compare.</p>{/if}
		</section>
		<section class="card p-3 text-sm">
			<h2 class="mb-1 font-medium">Most-cited sites</h2>
			<table class="w-full"><thead><tr><th class="th">Domain</th><th class="th text-right" title="Answers that cite it at least once">Answers</th></tr></thead>
				<tbody>{#each r.summary.topCited as t (t.domain)}<tr><td class="td pii">{t.domain}{#if t.ours}<span class="chip chip-on ml-2">you</span>{:else if t.competitor}<span class="chip ml-2">competitor</span>{/if}</td><td class="td tnum text-right">{t.answers}</td></tr>{:else}<tr><td class="td text-muted-foreground" colspan="2">No citations yet.</td></tr>{/each}</tbody></table>
		</section>
	</div>
{/if}

<h2 class="mb-1 font-medium">Prompts</h2>
<div class="stagger mb-5 space-y-2">
	{#each r.prompts as p (p.id)}
		<article class="card p-3 text-sm">
			<div class="flex items-start gap-2">
				<span class="pii min-w-0 flex-1 font-medium">{p.prompt}</span>
				<form method="POST" action="?/deletePrompt" use:enhance><input type="hidden" name="id" value={p.id} /><button class="btn !h-7 !px-2" title="Remove this prompt and its answers" aria-label="Remove prompt"><Trash2 class="size-3.5" /></button></form>
			</div>
			<div class="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-4">
				{#each p.answers as a (a.engine)}
					<div class="rounded border p-2 text-xs" style="border-color:var(--border)">
						<div class="mb-1 flex flex-wrap items-center gap-1.5"><b>{ENGINE_LABEL[a.engine]}</b>
							{#if !a.ran}<span class="text-muted-foreground">not asked yet</span>
							{:else if !a.ok}<span class="text-bad" title={a.error ?? ''}>failed</span>
							{:else if a.verdict}
								<span class="chip {a.verdict.mentioned ? 'chip-on' : ''}">{a.verdict.mentioned ? 'mentioned' : 'not mentioned'}</span>
								<span class="chip {a.verdict.cited ? 'chip-on' : ''}">{a.verdict.cited ? `cited #${a.verdict.position}` : 'not cited'}</span>
							{/if}
						</div>
						{#if a.ran}
							<div class="text-muted-foreground">{ago(a.at)}{a.model ? ` · ${a.model}` : ''}{a.via === 'dataforseo-scraper' ? ' · in the app, via DataForSEO' : a.via === 'dataforseo-responses' ? ' · via DataForSEO' : ''}{a.cost != null ? ` · ${usd(a.cost, 4)}` : ''}</div>
							{#if !a.ok}<div class="mt-1 text-bad">{a.error}</div>{/if}
							{#if a.ok && a.verdict && (a.verdict.competitorsMentioned.length || a.verdict.competitorsCited.length)}<div class="pii mt-1">Competitors: {[...new Set([...a.verdict.competitorsMentioned, ...a.verdict.competitorsCited])].join(', ')}</div>{/if}
							{#if a.ok && a.answer}
								<details class="mt-1"><summary class="cursor-pointer text-muted-foreground">Answer and {a.citations.length} source{a.citations.length === 1 ? '' : 's'}</summary>
									<p class="pii mt-1 max-h-48 overflow-auto whitespace-pre-wrap">{a.answer}</p>
									{#if a.citations.length}<ul class="mt-1 space-y-0.5">{#each a.citations as c}<li class="pii break-all"><a class="hover:underline" href={c.url} target="_blank" rel="noreferrer noopener nofollow">{c.title || c.url}</a></li>{/each}</ul>{/if}
								</details>
							{/if}
						{/if}
					</div>
				{/each}
			</div>
		</article>
	{:else}
		<div class="card p-4 text-sm text-muted-foreground">No prompts yet. Add the questions a customer would ask an assistant before buying what you sell.</div>
	{/each}
</div>

<div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
	<form method="POST" action="?/addPrompts" use:enhance class="card p-3 text-sm">
		<label class="grid gap-1.5 text-xs font-medium text-muted-foreground">Add prompts, one per line (up to {r.limits.maxPrompts} per site)
			<textarea class="input min-h-24 py-2 text-foreground" name="prompts" placeholder="best garden tools for a small yard&#10;is greenleaf or acme better for beginners?"></textarea>
		</label>
		<button class="btn mt-2">Add</button>
	</form>
	<form method="POST" action="?/competitors" use:enhance class="card p-3 text-sm">
		<label class="grid gap-1.5 text-xs font-medium text-muted-foreground">Competitors to compare with (domains, comma or line separated, up to 10)
			<textarea class="input min-h-24 py-2 text-foreground" name="competitors" placeholder="acme.com, example-rival.com">{r.competitors.join('\n')}</textarea>
		</label>
		<button class="btn mt-2">Save</button>
	</form>
</div>
