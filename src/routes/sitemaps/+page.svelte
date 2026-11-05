<script lang="ts">
	import { ConfirmButton } from '$lib/components/ui/confirm';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { enhance } from '$app/forms';
	import { fmtInt } from '$lib/format';
	let { data, form } = $props();
	let busy = $state(false);
</script>

<div class="mb-4 flex items-center gap-3">
	<h1 class="text-lg font-semibold">Sitemaps across all sites</h1>
	<form method="POST" action="?/resubmitAll" class="ml-auto" use:enhance={() => { busy = true; return async ({ update }) => { await update(); busy = false; }; }}>
		<ConfirmButton class="btn" destructive={false} title="Resubmit every known sitemap?" description="This asks Google to re-read every sitemap of every site. It does not guarantee faster indexing." confirmLabel="Resubmit all">{busy ? 'Resubmitting…' : 'Resubmit all'}</ConfirmButton>
	</form>
</div>
{#if form?.summary}<p class="mb-3 text-sm text-good">{form.summary}</p>{/if}
{#if form?.error}<p class="mb-3 text-sm text-bad">{form.error}</p>{/if}

{#await data.rows}
	<div class="card divide-y">
		{#each Array(6) as _}
			<div class="flex items-center gap-4 p-3"><Skeleton class="h-4 w-48" /><Skeleton class="h-4 w-24" /><Skeleton class="ml-auto h-4 w-40" /></div>
		{/each}
	</div>
	<p class="mt-2 text-xs text-muted-foreground">Asking Search Console about every property…</p>
{:then rows}
	<div class="card overflow-x-auto">
		<table class="w-full">
			<thead><tr><th class="th">Site</th><th class="th">Sitemaps</th><th class="th text-right">URLs submitted</th><th class="th text-right">Warnings</th><th class="th text-right">Errors</th><th class="th">Last read</th></tr></thead>
			<tbody>
				{#each rows as r (r.id)}
					{@const urls = r.sitemaps.reduce((a, s) => a + (s.contents ?? []).reduce((b, c) => b + Number(c.submitted ?? 0), 0), 0)}
					{@const warn = r.sitemaps.reduce((a, s) => a + Number(s.warnings ?? 0), 0)}
					{@const err = r.sitemaps.reduce((a, s) => a + Number(s.errors ?? 0), 0)}
					{@const last = r.sitemaps.map((s) => s.lastDownloaded ?? '').sort().pop()}
					<tr>
						<td class="td"><a class="hover:underline" href="/sites/{r.id}/sitemaps">{r.name}</a></td>
						{#if r.error}
							<td class="td text-bad" colspan="5">{r.error}</td>
						{:else}
							<td class="td {r.sitemaps.length ? '' : 'text-warn'}">{r.sitemaps.length || 'none submitted'}</td>
							<td class="td tnum text-right">{fmtInt(urls)}</td>
							<td class="td tnum text-right {warn ? 'text-warn' : ''}">{warn}</td>
							<td class="td tnum text-right {err ? 'text-bad' : ''}">{err}</td>
							<td class="td tnum">{last ? last.slice(0, 10) : '–'}</td>
						{/if}
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{/await}
