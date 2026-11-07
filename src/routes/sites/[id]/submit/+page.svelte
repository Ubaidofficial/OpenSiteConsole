<script lang="ts">
	import Explainer from '$lib/components/Explainer.svelte';
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { ago } from '$lib/format';
	let { data, form } = $props();
	let urls = $state('');
	let busy = $state(false);
	let channels = $state<Record<string, boolean>>({ indexnow: true, bing: true, google_indexing_api: true });
	// A preset only fills the box: nothing is sent until the owner presses Submit.
	$effect(() => {
		if (form?.prefill) urls = form.prefill;
	});
	// reset: false keeps the URLs in the box, so a dry run can be followed by the real submit without typing them again.
	const run = () => {
		busy = true;
		return async ({ update }: { update: (o?: { reset?: boolean }) => Promise<void> }) => {
			await update({ reset: false });
			await invalidateAll();
			busy = false;
		};
	};
	const LABEL: Record<string, string> = { indexnow: 'IndexNow', bing: 'Bing', google_indexing_api: 'Google Indexing API' };
	const count = $derived(urls.split(/\s+/).filter(Boolean).length);
	// `ago` is for the past; these are for a time still to come.
	const until = (t: number) => {
		const h = Math.round((t - Date.now()) / 3600_000);
		return h < 1 ? 'within the hour' : h < 48 ? `in ${h} h` : `in ${Math.round(h / 24)} days`;
	};
	const q = $derived(data.quota);
	const stillNot = $derived(data.submissions.filter((x) => x.verdict === 'still_not_indexed').length);
	const stateText = { indexed: 'indexed', not_indexed: 'not indexed', unknown: 'unknown' } as const;
</script>

<section class="card mb-4 p-4">
	<h2 class="mb-1 font-medium">Submit for indexing</h2>
	<Explainer lead="Send new or changed pages to the search engines that take them. For Google, keep your sitemap current and watch the table below.">
	<p>One place to tell the search engines that accept it about new or changed pages. <b class="text-foreground">Google has no "request indexing" button for ordinary pages that a tool can press</b>:
		for Google, keep your sitemap current (below), then watch whether each page got indexed in the table at the bottom. Google's Indexing API exists, but Google documents it for <b>job-posting and livestream pages only</b>, so every other page is refused, not sent.
		A channel saying <i>accepted</i> means it received the URL, not that the page is indexed.</p>
</Explainer>
	{#if data.readOnly}<p class="mt-2 text-sm text-warn">This server runs with READ_ONLY=1: only dry runs and checks work.</p>{/if}
</section>

{#if form?.ok}<p class="mb-3 text-sm text-good">{form.ok}</p>{/if}{#if form?.error}<p class="mb-3 text-sm text-bad">{form.error}</p>{/if}

<section class="card mb-4 p-4">
	<h2 class="mb-2 font-medium">1 · URLs</h2>
	<form method="POST" action="?/submit" use:enhance={run}>
		<textarea class="input h-28 w-full" name="urls" bind:value={urls} placeholder="Full URLs of this site, one per line (up to {data.maxUrls})"></textarea>
		<div class="mt-2 flex flex-wrap gap-2">
			<button class="btn !h-8 text-xs" formaction="?/preset" name="preset" value="new" formnovalidate disabled={busy || !data.presets.new} title="Sitemap URLs whose date is in the last 7 days">New pages ({data.presets.new})</button>
			<button class="btn !h-8 text-xs" formaction="?/preset" name="preset" value="never_shown" formnovalidate disabled={busy || !data.presets.never_shown} title="In a sitemap but never shown in search in 90 days: where indexing problems hide">Never shown ({data.presets.never_shown})</button>
			<button class="btn !h-8 text-xs" formaction="?/preset" name="preset" value="removed" formnovalidate disabled={busy || !data.presets.removed} title="Pages the indexing monitor saw return 404">Removed pages ({data.presets.removed})</button>
		</div>

		<h2 class="mt-4 mb-2 font-medium">2 · Where to send them</h2>
		<div class="space-y-2 text-sm">
			<label class="flex items-start gap-2"><input type="checkbox" name="channel" value="indexnow" bind:checked={channels.indexnow} class="mt-1" />
				<span><b>IndexNow</b> <span class="text-xs text-muted-foreground">Bing, Yandex, Naver, Seznam, Yep. Not Google.</span>
					{#if !data.channels.indexnow.hasKey}<span class="ml-1 text-xs text-warn">no key yet: <a class="underline" href="indexnow">set it up</a></span>
					{:else if !data.channels.indexnow.verifiedHosts}<span class="ml-1 text-xs text-warn">key file not verified yet: <a class="underline" href="indexnow">verify</a></span>
					{:else}<span class="ml-1 text-xs text-good">ready ({data.channels.indexnow.verifiedHosts} verified host{data.channels.indexnow.verifiedHosts === 1 ? '' : 's'})</span>{/if}</span></label>
			<label class="flex items-start gap-2"><input type="checkbox" name="channel" value="bing" bind:checked={channels.bing} class="mt-1" />
				<span><b>Bing URL submission</b> <span class="text-xs text-muted-foreground">Bing's own API, up to 500 URLs a call within its daily allowance.</span>
					{#if data.channels.bing.linked}<span class="ml-1 text-xs text-good">Bing linked</span>{:else}<span class="ml-1 text-xs text-warn">Bing not linked: <a class="underline" href="/connect">connect it</a></span>{/if}</span></label>
			<label class="flex items-start gap-2"><input type="checkbox" name="channel" value="google_indexing_api" bind:checked={channels.google_indexing_api} class="mt-1" />
				<span><b>Google Indexing API</b> <span class="text-xs text-muted-foreground">Only pages with JobPosting or livestream (BroadcastEvent) structured data; the page is read first and any other page is refused.</span>
					{#if data.channels.googleIndexing.enabled}<span class="ml-1 text-xs text-good">on ({data.channels.googleIndexing.cap - data.channels.googleIndexing.used} of {data.channels.googleIndexing.cap} left today)</span>
					{:else}<span class="ml-1 text-xs text-muted-foreground">off on this server (set <code>GOOGLE_INCLUDE_INDEXING=1</code> and reconnect Google to use it for those pages)</span>{/if}</span></label>
		</div>
		<div class="mt-3 flex flex-wrap items-center gap-3">
			<button class="btn btn-primary" disabled={busy || !count}>{busy ? 'Working…' : `Submit ${count || ''} URL${count === 1 ? '' : 's'}`}</button>
			<label class="flex items-center gap-1.5 text-xs text-muted-foreground"><input type="checkbox" name="dry" /> dry run (show what would happen, send nothing)</label>
			<label class="flex items-center gap-1.5 text-xs text-muted-foreground"><input type="checkbox" name="force" /> IndexNow: even if sent in the last 24 hours</label>
		</div>
		<div class="mt-2 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
			<label class="flex items-center gap-1.5">Spread over <input class="input !h-7 w-16" type="number" name="drip" min="1" max={data.maxDrip} value="1" aria-label="Days to spread the list over" /> day(s) <span>(1 = all now; otherwise an even share goes each day)</span></label>
			<label class="flex items-center gap-1.5"><input type="checkbox" name="queue" checked /> queue what does not fit today's limits and send it on the following days</label>
		</div>
	</form>

	{#if form?.report}
		{@const r = form.report}
		<div class="mt-4 border-t pt-3 text-sm" style="border-color:var(--border)">
			<h3 class="mb-1 font-medium">{r.dryRun ? 'Dry run: nothing was sent' : 'Result'} · {r.urls.length} URL{r.urls.length === 1 ? '' : 's'}</h3>
			<ul class="space-y-1.5">
				{#each r.channels as c}
					<li>
						<b>{LABEL[c.channel]}:</b>
						{#if !c.available}<span class="text-warn">not used: {c.reason}</span>
						{:else if r.dryRun}would take {c.attempted}
						{:else}<span class={c.accepted ? 'text-good' : 'text-bad'}>{c.accepted} of {c.attempted} accepted</span>{/if}
						{#if c.available && c.queued}<span class="text-xs text-muted-foreground"> · {c.queued} {r.dryRun ? 'would be ' : ''}queued for later</span>{/if}
						{#each c.skipped as s}<span class="text-xs text-muted-foreground"> · {s.count} skipped: {s.reason}</span>{/each}
						{#if c.error}<span class="text-xs text-bad"> · {c.error}</span>{/if}
						{#each c.notes as n}<div class="text-xs text-muted-foreground">{n}</div>{/each}
					</li>
				{/each}
			</ul>
			{#if r.rejected.length}<p class="mt-2 text-xs text-warn">{r.rejected.length} not used: {r.rejected.slice(0, 3).map((x: { url: string; reason: string }) => `${x.url} (${x.reason})`).join('; ')}{r.rejected.length > 3 ? '…' : ''}</p>{/if}
			{#if !r.dryRun && r.watching}<p class="mt-2 text-xs text-muted-foreground">{r.watching} URL{r.watching === 1 ? '' : 's'} added to the indexing monitor's watch list: it checks them first on its next run (or press <i>Check now</i> below).</p>{/if}
		</div>
	{/if}
</section>

<section class="card mb-4 p-4">
	<div class="mb-2 flex items-center gap-3">
		<h2 class="font-medium">Limits and queue</h2>
		{#if q.bing.linked}<form method="POST" action="?/refreshQuota" use:enhance={run} class="ml-auto"><button class="btn !h-8 text-xs" disabled={busy} title="Ask Bing now how many URLs it still takes (read-only)">Refresh Bing's figure</button></form>{/if}
	</div>
	<div class="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
		<div><div class="text-xs text-muted-foreground">IndexNow, last 24 h</div><div class="tnum font-medium">{q.indexnow.used24h.toLocaleString('en-US')} of {q.indexnow.cap.toLocaleString('en-US')}</div>
			<div class="text-xs {q.indexnow.pausedUntil ? 'text-warn' : q.indexnow.ready ? 'text-good' : 'text-muted-foreground'}">{q.indexnow.pausedUntil ? 'paused: the engines asked us to slow down' : q.indexnow.ready ? 'ready' : 'not set up'}</div></div>
		<div><div class="text-xs text-muted-foreground">Bing, still allowed</div>
			{#if !q.bing.linked}<div class="text-xs text-muted-foreground">Bing not linked</div>
			{:else if q.bing.checkedAt == null}<div class="text-xs text-muted-foreground">not read yet: refresh, or send once</div>
			{:else}<div class="tnum font-medium">{q.bing.daily == null ? 'unknown' : q.bing.daily.toLocaleString('en-US')} today</div><div class="text-xs text-muted-foreground">{q.bing.monthly == null ? '' : q.bing.monthly.toLocaleString('en-US') + ' this month · '}read {ago(q.bing.checkedAt)}</div>{/if}</div>
		<div><div class="text-xs text-muted-foreground">Google Indexing API, today</div>
			{#if q.googleIndexingApi.enabled}<div class="tnum font-medium">{q.googleIndexingApi.usedToday} of {q.googleIndexingApi.cap}</div><div class="text-xs text-muted-foreground">job and livestream pages only</div>
			{:else}<div class="text-xs text-muted-foreground">off on this server</div>{/if}</div>
		<div><div class="text-xs text-muted-foreground">Google URL Inspection, today (UTC)</div><div class="tnum font-medium">{q.urlInspection.storedToday.toLocaleString('en-US')} of about {q.urlInspection.approxDailyLimit.toLocaleString('en-US')}</div>
			<div class="text-xs text-muted-foreground">shared by this page, the monitor ({q.urlInspection.monitorPerRun} a run) and re-checks ({q.urlInspection.rechecksPerRun} a run)</div></div>
	</div>
	<div class="mt-3 flex flex-wrap items-center gap-3 border-t pt-3 text-sm" style="border-color:var(--border)">
		{#if q.queue.total}
			<span><b>{q.queue.total.toLocaleString('en-US')}</b> URL{q.queue.total === 1 ? '' : 's'} waiting to be sent{#each Object.entries(q.queue.byChannel) as [ch, n]}{#if n} · {LABEL[ch]} {n}{/if}{/each}.
				{#if q.queue.releasableNow}{q.queue.releasableNow} may go at the next run (every 15 minutes).{:else if q.queue.nextReleaseAt}Next release {until(q.queue.nextReleaseAt)}.{/if}</span>
			<form method="POST" action="?/clearQueue" use:enhance={run} class="ml-auto"><button class="btn !h-8 text-xs" disabled={busy || data.readOnly}>Clear the queue</button></form>
		{:else}<span class="text-muted-foreground">Nothing is waiting in the queue.</span>{/if}
	</div>
	<Explainer lead="Over-limit or spread-out URLs wait here and go automatically.">
	<p>URLs that do not fit a channel's daily limit, or that you chose to spread over several days, wait here and go automatically (every 15 minutes the server looks; the app must be running). Anything still unsent 7 days after it was due is dropped, and the log says so. The Google inspection limit is the figure Google documents as I understand it: verify it if it matters to you.</p>
</Explainer>
</section>

<section class="card mb-4 p-4">
	<h2 class="mb-1 font-medium">Sitemaps (Google)</h2>
	<p class="mb-2 max-w-3xl text-xs text-muted-foreground">This is Google's real route for ordinary pages. Search Console reads a sitemap on its own schedule: submitting it again is allowed but does not make Google read it sooner. Check a sitemap first to see why it may be pending.</p>
	<form method="POST" use:enhance={run} class="flex flex-wrap items-center gap-2">
		<input class="input min-w-72 flex-1" name="feed" placeholder="https://example.com/sitemap.xml" />
		<button class="btn" formaction="?/sitemapCheck" disabled={busy}>Check</button>
		<button class="btn btn-primary" formaction="?/sitemapSubmit" disabled={busy || data.readOnly}>Submit sitemap</button>
		<button class="btn" formaction="?/sitemapResubmit" formnovalidate disabled={busy || data.readOnly} title="Submit again every sitemap Search Console already lists for this site">Resubmit all listed</button>
	</form>
	{#if form?.check}
		{@const c = form.check}
		<div class="mt-3 text-sm">
			<div class="text-xs text-muted-foreground"><span class="pii">{c.url}</span> · {c.reachable ? `HTTP ${c.status}` : 'not reachable'} · {c.kind} · {c.urls.toLocaleString('en-US')} URLs{c.googlePending ? ' · Google: pending' : ''}</div>
			<ul class="mt-1 list-disc pl-5 text-xs">{#each c.notes as n}<li class={n.level === 'bad' ? 'text-bad' : n.level === 'warn' ? 'text-warn' : 'text-muted-foreground'}>{n.text}</li>{/each}</ul>
		</div>
	{/if}
</section>

<section class="card p-4">
	<div class="mb-2 flex items-center gap-3">
		<h2 class="font-medium">What happened to submitted URLs</h2>
		<a class="btn !h-8 text-xs ml-auto" href="submit/export" download title="The table below as a spreadsheet">Download CSV</a>
		<form method="POST" action="?/check" use:enhance={run}><button class="btn !h-8 text-xs" disabled={busy || data.readOnly} title="Re-inspect the watch list now (spends URL Inspection quota)">Check now</button></form>
	</div>
	{#if stillNot}<div class="mb-2 text-sm text-warn"><p><b>{stillNot}</b> URL{stillNot === 1 ? '' : 's'} still not indexed after {data.recheckDays[data.recheckDays.length - 1]} days. The coverage text below says why.</p>
		<details class="mt-1 text-xs text-muted-foreground"><summary class="cursor-pointer select-none">What do these mean?</summary><p class="mt-1 max-w-2xl">“Crawled – currently not indexed” usually means Google saw the page and did not think it worth keeping yet: improve the content and link to it from other pages. “Discovered – currently not indexed” means it knows the address but has not crawled it.</p></details></div>{/if}
	<div class="overflow-x-auto"><table class="w-full text-sm"><thead><tr><th class="th">URL</th><th class="th">Sent</th><th class="th">Channels</th><th class="th">Google says</th><th class="th">Next check</th></tr></thead><tbody>
		{#each data.submissions as s (s.url)}
			<tr>
				<td class="td pii max-w-80 truncate text-xs" title={s.url}>{s.url}</td>
				<td class="td whitespace-nowrap text-xs text-muted-foreground">{ago(s.submittedAt)}</td>
				<td class="td text-xs">{#each s.channels as c}<span class="mr-2 whitespace-nowrap {c.ok ? 'text-good' : 'text-bad'}" title={c.message}>{c.ok ? '✓' : '✕'} {LABEL[c.channel]}</span>{/each}</td>
				<td class="td text-xs">
					{#if s.verdict === 'still_not_indexed'}<span class="chip mr-1 !border-[color:var(--bad)] text-bad">still not indexed</span>{:else if s.verdict === 'indexed'}<span class="chip mr-1 text-good">indexed</span>{/if}
					{#if !s.google}<span class="text-muted-foreground">not inspected yet</span>
					{:else}<span class={s.google.state === 'indexed' ? 'text-good' : s.google.state === 'not_indexed' ? 'text-warn' : 'text-muted-foreground'}>{stateText[s.google.state as keyof typeof stateText]}</span>{#if s.google.coverage}<span class="text-muted-foreground"> · {s.google.coverage}</span>{/if}
						<span class="text-muted-foreground"> · checked {ago(s.google.checkedAt)}{s.google.checkedAfterSubmit ? '' : ' (before this submission)'}</span>{/if}
				</td>
				<td class="td whitespace-nowrap text-xs text-muted-foreground">{s.nextCheckAt ? (s.nextCheckAt <= Date.now() ? 'due' : until(s.nextCheckAt)) : s.verdict === 'indexed' ? 'done' : 'none left'}</td>
			</tr>
		{:else}<tr><td class="td text-muted-foreground" colspan="5">Nothing submitted yet.</td></tr>{/each}
	</tbody></table></div>
	<Explainer lead="Each accepted URL is re-checked with Google at day 1, 3 and 5.">
	<p>Each accepted URL is checked with Google again at day {data.recheckDays.join(', ')} automatically (and sits on the indexing monitor's watch list until then). "Not indexed" soon after sending is normal: Google decides on its own time, and the reason (such as "Crawled – currently not indexed") shows here once it is inspected.</p>
</Explainer>
</section>
