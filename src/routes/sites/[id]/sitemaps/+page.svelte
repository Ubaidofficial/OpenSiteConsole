<script lang="ts">
	import { ConfirmButton } from '$lib/components/ui/confirm';
	import { enhance } from '$app/forms';
	import { LoaderCircle, Send } from '@lucide/svelte';
	import { fmtInt } from '$lib/format';
	let { data, form } = $props();
	let busy = $state(false);
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
{#if data.sitemaps.some((s) => s.isPending)}<p class="mt-3 max-w-3xl text-xs text-muted-foreground"><b>Pending</b> means Google has accepted the submission and has not processed the file yet. After a resubmit it is normal: “Last read” and the URL count stay at their old values until Google fetches the sitemap again, which Google decides. Use <b>Check</b> to confirm the file itself is fine.</p>{/if}
<p class="mt-3 text-xs text-muted-foreground">Live from Search Console — not cached. Google reads a sitemap on its own schedule; resubmitting nudges it but does not guarantee immediate indexing.</p>
