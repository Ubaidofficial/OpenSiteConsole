<script lang="ts">
	import Explainer from '$lib/components/Explainer.svelte';
	import { ConfirmButton } from '$lib/components/ui/confirm';
	import { enhance } from '$app/forms';
	import { LoaderCircle, Send } from '@lucide/svelte';
	import { fmtInt, ago } from '$lib/format';
	let { data, form } = $props();
	let busy = $state(false);
	const r = $derived(data.lastmod.report);
	const rb = $derived(data.robots);
	let robotsBusy = $state(false);
</script>

{#if data.error}<p class="mb-3 text-sm text-bad">{data.error}</p>{/if}
{#if form?.error}<p class="mb-3 text-sm text-bad">{form.error}</p>{/if}
{#if form?.ok}<p class="mb-3 text-sm text-good">{form.ok}</p>{/if}

<form method="POST" action="?/submit" use:enhance={() => { busy = true; return async ({ update }) => { await update(); busy = false; }; }} class="mb-5 rounded-xl border bg-card p-4 shadow-xs">
	<label class="grid min-w-0 gap-1.5 text-xs font-medium text-muted-foreground">Submit a sitemap to Search Console
		<span class="flex min-w-0 flex-wrap gap-2">
			<input class="input w-full text-foreground sm:w-[28rem]" name="feed" placeholder="https://example.com/sitemap.xml" required />
			<button class="btn btn-primary" disabled={busy}>{#if busy}<LoaderCircle class="size-4 animate-spin" />Submitting…{:else}<Send class="size-4" />Submit sitemap{/if}</button>
		</span>
	</label>
</form>

<div class="overflow-x-auto rounded-xl border bg-card shadow-xs">
	<table class="w-full">
		<thead><tr><th class="th">Sitemap</th><th class="th">Submitted</th><th class="th">Last read</th><th class="th text-right">URLs</th><th class="th text-right">Warnings</th><th class="th text-right">Errors</th><th class="th relative"><span class="sr-only">Actions</span></th></tr></thead>
		<tbody>
			{#each data.sitemaps as s (s.path)}
				{@const urls = (s.contents ?? []).reduce((a, c) => a + Number(c.submitted ?? 0), 0)}
				<tr>
					<td class="td max-w-[28rem] truncate"><a class="pii hover:underline" href={s.path} target="_blank" rel="noreferrer noopener">{s.path}</a>{#if s.isPending}<span class="chip ml-2" title="Google accepted the submission but has not processed the sitemap yet. Normal after a (re)submit: the Last read date stays the old one until Google fetches the file again.">pending</span>{/if}{#if s.isSitemapsIndex}<span class="chip ml-2">index</span>{/if}</td>
					<td class="td tnum">{s.lastSubmitted?.slice(0, 10) ?? '–'}</td>
					<td class="td tnum">{s.lastDownloaded?.slice(0, 10) ?? '–'}</td>
					<td class="td tnum text-right">{fmtInt(urls)}</td>
					<td class="td tnum text-right {Number(s.warnings) ? 'text-warn' : ''}">{fmtInt(Number(s.warnings ?? 0))}</td>
					<td class="td tnum text-right {Number(s.errors) ? 'text-bad' : ''}">{fmtInt(Number(s.errors ?? 0))}</td>
					<td class="td whitespace-nowrap text-right">
						<form method="POST" action="?/check" use:enhance class="inline"><input type="hidden" name="feed" value={s.path} /><button class="btn" title="Fetch the sitemap like a crawler and compare it with what Google reported">Check</button></form>
						<form method="POST" action="?/submit" use:enhance class="inline"><input type="hidden" name="feed" value={s.path} /><button class="btn">Resubmit</button></form>
						<form method="POST" action="?/delete" use:enhance class="inline"><input type="hidden" name="feed" value={s.path} /><ConfirmButton title="Remove this sitemap from Search Console?" description="This removes the sitemap entry in Google Search Console itself, for everyone with access to the property." confirmLabel="Remove sitemap">Remove</ConfirmButton></form>
					</td>
				</tr>
			{:else}
				<tr><td class="td text-muted-foreground" colspan="7">No sitemaps submitted for this property.</td></tr>
			{/each}
		</tbody>
	</table>
</div>
{#if form?.check}
	{@const c = form.check}
	<section class="card mt-4 p-4 text-sm">
		<h2 class="mb-1 font-medium">Check: <span class="pii break-all font-normal">{c.url}</span></h2>
		<p class="mb-2 text-xs text-muted-foreground">{c.reachable ? `Fetched: HTTP ${c.status}, ${c.contentType || 'no content type'}, ${(c.bytes / 1024).toFixed(0)} KB` : 'Could not be fetched'} · {c.kind === 'urlset' ? 'URL sitemap' : c.kind === 'index' ? 'sitemap index' : c.kind}{c.reachable ? ` · ${c.urls.toLocaleString('en-US')} URLs${c.withLastmod ? `, ${c.withLastmod.toLocaleString('en-US')} with a date` : ''}` : ''}{c.googleCounted != null ? ` · Google last counted ${c.googleCounted.toLocaleString('en-US')}` : ''}{c.googleRead ? `, read ${c.googleRead.slice(0, 10)}` : ''}</p>
		<ul class="space-y-1.5">{#each c.notes as n}<li class="flex gap-2 text-xs"><span class={n.level === 'bad' ? 'text-bad' : n.level === 'warn' ? 'text-warn' : 'text-muted-foreground'}>{n.level === 'bad' ? '✕' : n.level === 'warn' ? '⚠' : 'ℹ'}</span><span>{n.text}</span></li>{/each}</ul>
	</section>
{/if}
{#if data.sitemaps.some((s) => s.isPending)}<Explainer lead="Pending: Google has the submission and has not processed it yet.">
	<p><b>Pending</b> means Google has accepted the submission and has not processed the file yet. After a resubmit it is normal: “Last read” and the URL count stay at their old values until Google fetches the sitemap again, which Google decides. Use <b>Check</b> to confirm the file itself is fine.</p>
</Explainer>{/if}
<section id="robots" class="card mt-6 scroll-mt-20 p-4 text-sm">
	<div class="mb-1 flex flex-wrap items-center gap-2">
		<h2 class="font-medium">robots.txt watch</h2>
		{#if rb.hosts.length}
			{@const bad = rb.blocked.length > 0 || rb.hosts.some((h) => h.state === 'error' && h.failStreak >= rb.errorStreak)}
			<span class="chip {bad ? 'border-[color:var(--bad)] text-bad' : 'text-good'}">{bad ? 'needs fixing' : 'nothing blocked'}</span>
		{/if}
		<form method="POST" action="?/robotsCheck" use:enhance={() => { robotsBusy = true; return async ({ update }) => { await update(); robotsBusy = false; }; }} class="ml-auto">
			<button class="btn !h-8 text-xs" disabled={robotsBusy}>{#if robotsBusy}<LoaderCircle class="size-4 animate-spin" />Reading…{:else}Check now{/if}</button>
		</form>
	</div>
	<Explainer lead="Read once a day; pages that earn clicks are tested against the rules Googlebot obeys.">
		<p>Once a day SEOConsole reads <code>/robots.txt</code> on each host your clicks come from (up to three), keeps every change in what the rules mean (comments and blank lines are ignored), and tests the pages that earned clicks in the last 28 days against the group Googlebot obeys. A rule that blocks them, or a file that keeps answering with server errors, goes to the top of the action queue and to urgent alerts. Matching follows the published robots.txt standard as this app understands it; confirm a surprising result in Search Console's robots.txt report.</p>
	</Explainer>
	{#if !rb.hosts.length}
		<p class="text-xs text-muted-foreground">Not read yet. It is read within a day of adding the site, or now with <b>Check now</b>.</p>
	{:else}
		<ul class="mb-2 space-y-1 text-xs">
			{#each rb.hosts as h (h.origin)}
				<li class="flex flex-wrap gap-x-3 gap-y-0.5">
					<a class="pii font-medium hover:underline" href="{h.origin}/robots.txt" target="_blank" rel="noreferrer noopener">{h.origin.replace(/^https?:\/\//, '')}</a>
					<span class={h.state === 'error' ? 'text-bad' : 'text-muted-foreground'}>{h.state === 'ok' ? `HTTP ${h.status}` : h.state === 'missing' ? `no file (HTTP ${h.status}): everything may be crawled` : `error: ${h.error ?? 'no answer'} (${h.failStreak} read${h.failStreak === 1 ? '' : 's'} in a row)`}</span>
					{#if h.group}<span class="text-muted-foreground">Googlebot obeys the <code>{h.group}</code> group: {h.rules} rule{h.rules === 1 ? '' : 's'}</span>{:else if h.body != null}<span class="text-muted-foreground">no group applies to Googlebot</span>{/if}
					<span class="text-muted-foreground">read {ago(h.checkedAt)}{h.changedAt ? ` · last changed ${ago(h.changedAt)}` : ''}</span>
				</li>
			{/each}
		</ul>
		{#if rb.blocked.length}
			<p class="mb-1 text-xs text-bad">✕ Blocks {rb.blocked.length} page{rb.blocked.length === 1 ? '' : 's'} that earned clicks in the last 28 days:</p>
			<ul class="mb-2 space-y-0.5 text-xs">{#each rb.blocked.slice(0, 10) as b (b.url)}<li class="break-all"><span class="pii">{b.url}</span> <span class="text-muted-foreground">· {fmtInt(b.clicks)} clicks · <code>{b.rule}</code></span></li>{/each}</ul>
		{:else}
			<p class="mb-2 text-xs text-good">✓ No page that earned clicks in the last 28 days is blocked for Googlebot.</p>
		{/if}
		{#if rb.changes.length}
			<details class="text-xs"><summary class="cursor-pointer text-muted-foreground">Changes ({rb.changes.length} most recent)</summary>
				<ul class="mt-1 space-y-2">
					{#each rb.changes as c (c.id)}
						<li>
							<div class="text-muted-foreground">{new Date(c.at).toISOString().slice(0, 16).replace('T', ' ')} UTC · <span class="pii">{c.origin.replace(/^https?:\/\//, '')}</span>{c.beforeState !== c.afterState ? ` · ${c.beforeState} → ${c.afterState}` : ''}</div>
							<ul class="pii font-mono">{#each c.removed as l}<li class="text-bad">− {l}</li>{/each}{#each c.added as l}<li class="text-good">+ {l}</li>{/each}</ul>
							{#if c.beforeBody}<details><summary class="cursor-pointer text-muted-foreground">The file before this change</summary><pre class="pii mt-1 max-h-60 overflow-auto whitespace-pre-wrap rounded border p-2">{c.beforeBody}</pre></details>{/if}
						</li>
					{/each}
				</ul>
			</details>
		{/if}
		{#each rb.hosts.filter((h) => h.body != null) as h (h.origin)}
			<details class="mt-1 text-xs"><summary class="cursor-pointer text-muted-foreground">The file as read on <span class="pii">{h.origin.replace(/^https?:\/\//, '')}</span></summary><pre class="pii mt-1 max-h-60 overflow-auto whitespace-pre-wrap rounded border p-2">{h.body}</pre></details>
		{/each}
	{/if}
</section>
<section class="card mt-6 p-4 text-sm">
	<div class="mb-1 flex flex-wrap items-center gap-2">
		<h2 class="font-medium">Are the dates in your sitemap believable?</h2>
		{#if r.verdict !== 'unknown'}<span class="chip {r.verdict === 'bad' ? 'border-[color:var(--bad)] text-bad' : r.verdict === 'warn' ? 'text-warn' : 'text-good'}">{r.verdict === 'good' ? 'looks good' : r.verdict === 'warn' ? 'worth a look' : 'needs fixing'}</span>{/if}
	</div>
	<Explainer lead="Google re-crawls using each URL's lastmod, but only if it can trust it.">
	<p>Google uses each URL's <code>lastmod</code> to decide what to re-crawl, but only when the date is valid and it can trust it: dates that keep claiming changes that did not happen get ignored. This checks yours from the last sitemap read{r.readAt ? ` (${ago(r.readAt)})` : ''}. The thresholds are this app's own rules of thumb, not Google's.</p>
</Explainer>
	{#if r.synced}
		<div class="mb-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
			<span><b class="tnum text-foreground">{fmtInt(r.total)}</b> URLs</span><span><b class="tnum text-foreground">{fmtInt(r.withDate)}</b> with a date</span>
			<span><b class="tnum text-foreground">{fmtInt(r.distinctDays)}</b> different days</span><span><b class="tnum text-foreground">{fmtInt(r.changedLast7d)}</b> changed in the last 7 days</span>
			{#if r.oldest}<span>{r.oldest} → {r.newest}</span>{/if}
		</div>
	{/if}
	<ul class="space-y-1.5">{#each r.findings as n}<li class="flex gap-2 text-xs"><span class={n.level === 'bad' ? 'text-bad' : n.level === 'warn' ? 'text-warn' : n.level === 'good' ? 'text-good' : 'text-muted-foreground'}>{n.level === 'bad' ? '✕' : n.level === 'warn' ? '!' : n.level === 'good' ? '✓' : 'i'}</span><span>{n.text}</span></li>{/each}</ul>
	{#if r.recrawl.examples.length}
		<details class="mt-2 text-xs"><summary class="cursor-pointer text-muted-foreground">Pages Google had not re-crawled after their date ({r.recrawl.examples.length} shown)</summary>
			<ul class="mt-1 space-y-0.5">{#each r.recrawl.examples as e}<li class="pii break-all">{e.url} · dated {e.lastmod}, last crawled {e.lastCrawl}</li>{/each}</ul></details>
	{/if}
	<div class="mt-3 border-t pt-3" style="border-color:var(--border)">
		<form method="POST" action="?/lastmodCompare" use:enhance class="flex flex-wrap items-center gap-3">
			<button class="btn !h-8 text-xs" disabled={!r.synced || r.withDate === 0} title="Fetches up to {data.lastmod.sample} of your pages and reads the Last-Modified header each sends">Compare with the pages' own dates</button>
			<span class="text-xs text-muted-foreground">Fetches up to {data.lastmod.sample} pages from your site (only your own host). Many sites send no such header; then it says it cannot tell.</span>
		</form>
		{#if data.lastmod.live}
			{@const l = data.lastmod.live}
			<ul class="mt-2 space-y-1.5">{#each l.findings as n}<li class="flex gap-2 text-xs"><span class={n.level === 'bad' ? 'text-bad' : n.level === 'warn' ? 'text-warn' : n.level === 'good' ? 'text-good' : 'text-muted-foreground'}>{n.level === 'bad' ? '✕' : n.level === 'warn' ? '!' : n.level === 'good' ? '✓' : 'i'}</span><span>{n.text} <span class="text-muted-foreground">(checked {ago(l.at)})</span></span></li>{/each}</ul>
			{#if l.examples.length}<ul class="pii mt-1 space-y-0.5 text-xs text-muted-foreground">{#each l.examples.slice(0, 5) as e}<li class="break-all">{e.url} · sitemap {e.lastmod}, page header {e.header} (sitemap date {Math.abs(e.daysApart)} days {e.daysApart > 0 ? 'later' : 'earlier'})</li>{/each}</ul>{/if}
		{/if}
	</div>
</section>
<Explainer lead="Live from Search Console, not cached.">
	<p>Live from Search Console — not cached. Google reads a sitemap on its own schedule; resubmitting nudges it but does not guarantee immediate indexing.</p>
</Explainer>
