<script lang="ts">
	import { enhance } from '$app/forms';
	import { ago, shortUrl } from '$lib/format';
	let { data, form } = $props();
	let busy = $state(false);
	const tone = (v?: string) => (v === 'PASS' ? 'text-good' : v === 'FAIL' ? 'text-bad' : 'text-warn');
</script>

<div class="card mb-4 p-4">
	<form method="POST" action="?/inspect" use:enhance={() => { busy = true; return async ({ update }) => { await update(); busy = false; }; }}>
		<textarea class="input h-24 w-full font-mono text-xs" name="urls" placeholder="One URL per line (max 20 per run)"></textarea>
		<div class="mt-2 flex flex-wrap items-center gap-3">
			<button class="btn btn-primary" disabled={busy}>{busy ? 'Inspecting…' : 'Inspect URLs'}</button>
			<button class="btn" formaction="?/top" disabled={busy}>Inspect top 10 pages</button>
			<label class="flex items-center gap-1 text-xs"><input type="checkbox" name="force" /> bypass 12h cache</label>
		</div>
	</form>
	{#if form?.error}<p class="mt-2 text-sm text-bad">{form.error}</p>{/if}
	{#if form && 'live' in form}<p class="mt-2 text-xs text-muted-foreground">{form.live} fetched from Google, {form.cached} from cache.{form.truncated ? ' Only the first 20 URLs were used.' : ''}</p>{/if}
</div>

<div class="card overflow-x-auto">
	<table class="w-full">
		<thead><tr><th class="th">URL</th><th class="th">Verdict</th><th class="th">Coverage</th><th class="th">Last crawl</th><th class="th">Canonical</th><th class="th">Checked</th></tr></thead>
		<tbody>
			{#each data.results as { url, at, r } (url)}
				{@const s = r.indexStatusResult}
				<tr>
					<td class="td max-w-[26rem] truncate"><a class="hover:underline" href={url} target="_blank" rel="noreferrer noopener" title={url}>{shortUrl(url)}</a></td>
					{#if r.error}
						<td class="td text-bad" colspan="4">{r.error}</td>
					{:else}
						<td class="td font-medium {tone(s?.verdict)}">{s?.verdict ?? '–'}</td>
						<td class="td">{s?.coverageState ?? '–'}</td>
						<td class="td tnum">{s?.lastCrawlTime?.slice(0, 10) ?? '–'}</td>
						<td class="td">
							{#if s?.googleCanonical && s?.userCanonical && s.googleCanonical !== s.userCanonical}<span class="text-warn" title="Google chose {s.googleCanonical}">mismatch</span>{:else}ok{/if}
						</td>
					{/if}
					<td class="td text-xs text-muted-foreground">{ago(at)}</td>
				</tr>
			{:else}
				<tr><td class="td text-muted-foreground" colspan="6">Nothing inspected yet.</td></tr>
			{/each}
		</tbody>
	</table>
</div>
<p class="mt-3 text-xs text-muted-foreground">Uses the URL Inspection API (quota is per property, roughly 2,000 inspections per day — verify current limits in Google’s docs). Results are cached for 12 hours.</p>
