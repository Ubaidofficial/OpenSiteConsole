<script lang="ts">
	import { enhance } from '$app/forms';
	import { fmtInt } from '$lib/format';
	let { data, form } = $props();
</script>

{#if data.error}<p class="mb-3 text-sm text-bad">{data.error}</p>{/if}
{#if form?.error}<p class="mb-3 text-sm text-bad">{form.error}</p>{/if}
{#if form?.ok}<p class="mb-3 text-sm text-good">{form.ok}</p>{/if}

<form method="POST" action="?/submit" use:enhance class="mb-4 flex gap-2">
	<input class="input w-[28rem] max-w-full" name="feed" placeholder="https://example.com/sitemap.xml" required />
	<button class="btn btn-primary">Submit sitemap</button>
</form>

<div class="card overflow-x-auto">
	<table class="w-full">
		<thead><tr><th class="th">Sitemap</th><th class="th">Submitted</th><th class="th">Last read</th><th class="th text-right">URLs</th><th class="th text-right">Warnings</th><th class="th text-right">Errors</th><th class="th"></th></tr></thead>
		<tbody>
			{#each data.sitemaps as s (s.path)}
				{@const urls = (s.contents ?? []).reduce((a, c) => a + Number(c.submitted ?? 0), 0)}
				<tr>
					<td class="td max-w-[28rem] truncate"><a class="hover:underline" href={s.path} target="_blank" rel="noreferrer noopener">{s.path}</a>{#if s.isPending}<span class="chip ml-2">pending</span>{/if}{#if s.isSitemapsIndex}<span class="chip ml-2">index</span>{/if}</td>
					<td class="td tnum">{s.lastSubmitted?.slice(0, 10) ?? '–'}</td>
					<td class="td tnum">{s.lastDownloaded?.slice(0, 10) ?? '–'}</td>
					<td class="td tnum text-right">{fmtInt(urls)}</td>
					<td class="td tnum text-right {Number(s.warnings) ? 'text-warn' : ''}">{fmtInt(Number(s.warnings ?? 0))}</td>
					<td class="td tnum text-right {Number(s.errors) ? 'text-bad' : ''}">{fmtInt(Number(s.errors ?? 0))}</td>
					<td class="td whitespace-nowrap text-right">
						<form method="POST" action="?/submit" use:enhance class="inline"><input type="hidden" name="feed" value={s.path} /><button class="btn">Resubmit</button></form>
						<form method="POST" action="?/delete" use:enhance class="inline" onsubmit={(e) => { if (!confirm('Remove this sitemap from Search Console?')) e.preventDefault(); }}><input type="hidden" name="feed" value={s.path} /><button class="btn btn-danger">Remove</button></form>
					</td>
				</tr>
			{:else}
				<tr><td class="td text-muted" colspan="7">No sitemaps submitted for this property.</td></tr>
			{/each}
		</tbody>
	</table>
</div>
<p class="mt-3 text-xs text-muted">Live from Search Console — not cached. Google reads a sitemap on its own schedule; resubmitting nudges it but does not guarantee immediate indexing.</p>
