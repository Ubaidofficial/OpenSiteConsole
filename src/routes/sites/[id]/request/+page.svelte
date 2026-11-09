<script lang="ts">
	import Explainer from '$lib/components/Explainer.svelte';
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import { ago } from '$lib/format';
	let { data, form } = $props();
	let busy = $state(false);
	// One-at-a-time mode: shows only the first unanswered row. Recording or skipping it reloads the list, so the next one takes its place.
	let focus = $state(false);
	let total = $state(0);
	const start = () => { total = q.pending.length; focus = true; };
	const q = $derived(data.queue);
	const run = () => {
		busy = true;
		return async ({ update }: { update: (o?: { reset?: boolean }) => Promise<void> }) => {
			await update({ reset: false });
			await invalidateAll();
			busy = false;
		};
	};
	const until = (t: number) => {
		const h = Math.round((t - Date.now()) / 3600_000);
		return h < 1 ? 'within the hour' : h < 48 ? `in ${h} h` : `in ${Math.round(h / 24)} days`;
	};
	const copy = (u: string) => navigator.clipboard?.writeText(u).then(() => toast.success('URL copied'), () => toast.error('Could not copy'));
	const stateText = { indexed: 'indexed', not_indexed: 'not indexed', unknown: 'unknown' } as const;
	const TIER = ['', 'new or changed', 'pinned', 'never shown', 'sent, not indexed'];
</script>

<section class="card mb-4 p-4">
	<h2 class="mb-1 font-medium">Request indexing: the one fast, official way to ask Google</h2>
	<Explainer lead="Search Console's Request Indexing button has no API, so no tool can press it. This page prepares the list and tracks the result.">
	<p>Search Console's <b class="text-foreground">Request Indexing</b> button is the one official way to ask Google to look at a page soon, and it has <b class="text-foreground">no API</b>, so no tool can press it for you. What this page does is the slow part: it picks the few pages worth asking about,
		skips what Google already has, sets aside pages where asking is pointless, links you straight to each, and keeps track of what you asked and whether it worked. It asks Google about the candidates first, which uses URL Inspection quota.</p>
</Explainer>
	<form method="POST" action="?/auto" use:enhance class="mt-2 flex flex-wrap items-center gap-2 text-sm">
		<input type="hidden" name="on" value={data.auto ? '0' : '1'} />
		<span class="chip {data.auto ? 'chip-on' : ''}">{data.auto ? 'Daily list: on' : 'Daily list: off'}</span>
		<button class="btn !h-8 text-xs {data.auto ? '' : 'btn-primary'}">{data.auto ? 'Switch off' : 'Build it every morning'}</button>
		<span class="text-xs text-muted-foreground">Builds the list for you each day (it spends URL Inspection quota){data.webhookSet ? ' and posts to your webhook when pages are ready' : '; set DIGEST_WEBHOOK_URL to also get a message'}. It never presses the button for you.</span>
	</form>
	<p class="mt-2 text-sm">
		<b>{q.budget.usedLast24h}</b> asked in the last 24 hours of about <b>{q.budget.perDay}</b> a day.
		{#if q.budget.left === 0}<span class="text-warn"> Allowance used up{q.budget.nextSlotAt ? `: next slot ${until(q.budget.nextSlotAt)}` : ''}.</span>{:else}<span class="text-good"> {q.budget.left} left.</span>{/if}
		<span class="text-xs text-muted-foreground"> <span title="Google does not publish its limit. Third-party sources say about 10 to 12 a day, which is unverified. Change it with REQUEST_INDEXING_PER_DAY.">(Google does not publish its limit)</span></span>
	</p>
</section>

{#if form?.ok}<p class="mb-3 text-sm text-good">{form.ok}</p>{/if}{#if form?.error}<p class="mb-3 text-sm text-bad">{form.error}</p>{/if}

<section class="card mb-4 p-4">
	<div class="mb-2 flex flex-wrap items-center gap-3">
		<h2 class="font-medium">Today's list</h2>
		{#if q.builtAt}<span class="text-xs text-muted-foreground">built {ago(q.builtAt)}</span>{/if}
		{#if q.pending.length && !focus}<button class="btn" type="button" onclick={start}>Go through them one by one</button>{/if}
		<form method="POST" action="?/build" use:enhance={run} class="ml-auto"><button class="btn btn-primary" disabled={busy || q.budget.left === 0}>{busy ? 'Asking Google…' : q.pending.length ? 'Rebuild the list' : 'Build today\'s list'}</button></form>
	</div>
	{#if q.pending.length && focus}
		{@const it = q.pending[0]}
		<div class="rounded border p-4" style="border-color:var(--border)">
			<div class="mb-2 flex items-center gap-2 text-xs"><span class="chip chip-on tnum">{Math.max(1, total - q.pending.length + 1)} of {total}</span><span class="chip">{TIER[it.tier]}</span>
				{#if it.state}<span class="chip {it.state === 'indexed' ? 'text-good' : it.state === 'not_indexed' ? 'text-warn' : ''}">Google: {stateText[it.state]}</span>{/if}
				<button class="ml-auto text-xs underline" type="button" onclick={() => (focus = false)}>Show the whole list</button></div>
			<div class="pii break-all text-base font-medium">{it.url}</div>
			<p class="mt-1 text-xs text-muted-foreground">{it.reason}</p>
			<ol class="mt-3 list-decimal space-y-2 pl-5 text-sm">
				<li>{#if it.link}<a class="btn btn-primary !h-8 text-xs" href={it.link} target="_blank" rel="noreferrer noopener">Open in Search Console ↗</a>{:else}<a class="btn !h-8 text-xs" href="https://search.google.com/search-console" target="_blank" rel="noreferrer noopener">Open Search Console ↗</a> <button class="btn !h-8 text-xs" type="button" onclick={() => copy(it.url)}>Copy URL</button> <span class="text-xs text-muted-foreground">then paste it into the inspection bar</span>{/if}</li>
				<li>Press <b>Request indexing</b> there (Google may run a live test first).</li>
				<li>Come back and press <b>Done, next</b>. Only press it after you really requested it: it starts the day 1, 3 and 5 checks.</li>
			</ol>
			<div class="mt-3 flex flex-wrap gap-2">
				<form method="POST" action="?/requested" use:enhance={run}><input type="hidden" name="url" value={it.url} /><button class="btn btn-primary" disabled={busy}>Done, next →</button></form>
				<form method="POST" action="?/dismiss" use:enhance={run}><input type="hidden" name="url" value={it.url} /><button class="btn" disabled={busy} title="Hide it for 30 days">Skip, next</button></form>
			</div>
		</div>
	{:else if q.pending.length}
		<ol class="space-y-3">
			{#each q.pending as it, i (it.url)}
				<li class="rounded border p-3" style="border-color:var(--border)">
					<div class="flex flex-wrap items-center gap-2 text-xs"><span class="tnum grid size-5 place-items-center rounded-full bg-muted font-semibold">{i + 1}</span><span class="chip">{TIER[it.tier]}</span>
						{#if it.state}<span class="chip {it.state === 'indexed' ? 'text-good' : it.state === 'not_indexed' ? 'text-warn' : ''}">Google: {stateText[it.state]}</span>{/if}</div>
					<div class="pii mt-1 break-all text-sm font-medium">{it.url}</div>
					<p class="mt-0.5 text-xs text-muted-foreground">{it.reason}</p>
					<div class="mt-2 flex flex-wrap items-center gap-2">
						{#if it.link}<a class="btn btn-primary !h-8 text-xs" href={it.link} target="_blank" rel="noreferrer noopener">Open in Search Console ↗</a>
						{:else}<a class="btn !h-8 text-xs" href="https://search.google.com/search-console" target="_blank" rel="noreferrer noopener" title="Paste the URL into the inspection bar at the top">Open Search Console ↗</a>{/if}
						<button class="btn !h-8 text-xs" type="button" onclick={() => copy(it.url)}>Copy URL</button>
						<form method="POST" action="?/requested" use:enhance={run}><input type="hidden" name="url" value={it.url} /><button class="btn !h-8 text-xs" disabled={busy} title="After you pressed Request Indexing there">I requested it</button></form>
						<form method="POST" action="?/dismiss" use:enhance={run}><input type="hidden" name="url" value={it.url} /><button class="btn !h-8 text-xs" disabled={busy} title="Hide it for 30 days">Skip</button></form>
					</div>
				</li>
			{/each}
		</ol>
		<Explainer lead="Open each link, press Request indexing there, then mark it done.">
	<p>In Search Console the inspection of that URL opens: press <b>Request indexing</b> there (Google may run a live test first), then come back and press <i>I requested it</i> so the result is tracked. Pressing the button does not guarantee indexing: Google still decides.</p>
</Explainer>
	{:else}
		<p class="text-sm text-muted-foreground">{q.builtAt ? 'Nothing is worth asking about right now: what Google has not indexed is blocked or already requested, or everything is indexed.' : 'No list yet. Build it to ask Google about your best candidates.'}</p>
	{/if}
</section>

{#if q.problems.length}
	<section class="card mb-4 p-4">
		<h2 class="mb-1 font-medium">Fix these first ({q.problems.length})</h2>
		<p class="mb-2 text-xs text-muted-foreground">Asking Google about these would not help: something stops them being indexed.</p>
		<ul class="space-y-2 text-sm">{#each q.problems as it (it.url)}<li><span class="pii break-all font-medium">{it.url}</span><div class="text-xs text-warn">{it.reason}</div></li>{/each}</ul>
	</section>
{/if}

<section class="card p-4">
	<h2 class="mb-2 font-medium">Asked in the last {data.cooldownDays} days</h2>
	<div class="overflow-x-auto"><table class="w-full text-sm"><thead><tr><th class="th">URL</th><th class="th">Asked</th><th class="th">Result</th><th class="th">Next check</th></tr></thead><tbody>
		{#each q.recent as r (r.url)}
			<tr><td class="td pii max-w-96 truncate text-xs" title={r.url}>{r.url}</td><td class="td whitespace-nowrap text-xs text-muted-foreground">{r.actedAt ? ago(r.actedAt) : ''}</td>
				<td class="td text-xs">{#if r.verdict === 'indexed'}<span class="text-good">indexed</span>{:else if r.verdict === 'still_not_indexed'}<span class="text-bad">still not indexed after {r.daysSince} days</span>{:else}<span class="text-muted-foreground">waiting</span>{/if}</td>
				<td class="td whitespace-nowrap text-xs text-muted-foreground">{r.nextCheckAt ? (r.nextCheckAt <= Date.now() ? 'due' : until(r.nextCheckAt)) : r.verdict === 'indexed' ? 'done' : 'none left'}</td></tr>
		{:else}<tr><td class="td text-muted-foreground" colspan="4">Nothing recorded yet.</td></tr>{/each}
	</tbody></table></div>
	<Explainer lead="Each request is re-checked with Google at day 1, 3 and 5.">
	<p>Each request is checked with Google again at day 1, 3 and 5 (see also the Submit tab). A URL you asked about stays off the list for {data.cooldownDays} days, so you are not asked to repeat it.</p>
</Explainer>
</section>
