<script lang="ts">
	import Explainer from '$lib/components/Explainer.svelte';
	import { LoaderCircle } from '@lucide/svelte';
	import { ConfirmButton } from '$lib/components/ui/confirm';
	import { enhance } from '$app/forms';
	import { fmtInt, ago } from '$lib/format';
	import { SYNC_RUNS_EXPLAIN, syncModeLabel } from '$lib/explain';
	let { data: page, form } = $props();
	let saving = $state(false);
</script>

{#if form?.ok}<p class="mb-3 text-sm text-good">{form.ok}</p>{/if}
{#if form?.error}<p class="mb-3 text-sm text-bad">{form.error}</p>{/if}

<div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
	<section class="card p-4">
		<h2 class="mb-3 font-medium">Site preferences</h2>
		<form method="POST" action="?/save" use:enhance={() => { saving = true; return async ({ update }) => { await update({ reset: false }); saving = false; }; }} class="space-y-4 text-sm">
			<label class="block"><span class="text-xs text-muted-foreground">Display name</span><input class="input w-full" name="label" value={page.site?.label ?? ''} /></label>
			<label class="block"><span class="text-xs text-muted-foreground">Tags (comma separated)</span><input class="input w-full" name="tags" value={page.site?.tags ?? ''} /></label>
			<label class="block"><span class="text-xs text-muted-foreground">Brand terms (comma separated; used to split branded vs non-branded)</span><input class="input w-full" name="brand" value={page.site?.brandTerms ?? ''} /></label>
			<label class="flex items-center gap-2"><input type="checkbox" name="hidden" checked={page.site?.hidden} /> Hide from dashboard and stop scheduled syncs</label>
			<button class="btn btn-primary" disabled={saving}>{#if saving}<LoaderCircle class="size-4 animate-spin" />Saving…{:else}Save changes{/if}</button>
		</form>
	</section>

	<section class="card p-4 text-sm">
		<h2 class="mb-3 font-medium">Stored data</h2>
		<p class="tnum">{fmtInt(page.stored.days)} days of totals · {fmtInt(page.stored.detail)} query/page rows</p>
		<p class="mt-1 text-xs text-muted-foreground">Per-day detail is capped at {fmtInt(page.maxRowsPerDay)} rows (MAX_ROWS_PER_DAY). Long-tail rows beyond the cap are not stored; totals are always complete.</p>
		<form method="POST" action="?/resync" use:enhance class="mt-3">
			<ConfirmButton class="btn" destructive={false} title="Reset and re-pull history?" description="The locally stored data for this site is deleted and downloaded again from Google. This can take a while." confirmLabel="Reset and re-pull">Reset &amp; re-pull history</ConfirmButton>
		</form>
	</section>

	<section class="card overflow-x-auto lg:col-span-2">
		<h2 class="p-4 pb-1 font-medium">Recent syncs</h2>
		<div class="px-4 pb-2"><Explainer lead="Each run re-pulls the newest days, and pulls more history until it is complete."><p>{SYNC_RUNS_EXPLAIN}</p></Explainer></div>
		<table class="w-full">
			<thead><tr><th class="th">Started</th><th class="th">Mode</th><th class="th text-right">Days</th><th class="th text-right">Rows</th><th class="th">Result</th></tr></thead>
			<tbody>
				{#each page.runs as r}
					<tr>
						<td class="td">{ago(r.started_at)}</td><td class="td">{syncModeLabel(r.mode)}</td>
						<td class="td tnum text-right">{r.days}</td><td class="td tnum text-right">{fmtInt(r.rows)}</td>
						<td class="td">{#if r.error}<span class="text-bad">{r.error}</span>{:else if !r.finished_at}running…{:else}ok{r.truncated_days ? ` · ${r.truncated_days} day(s) capped` : ''}{/if}</td>
					</tr>
				{:else}<tr><td class="td text-muted-foreground" colspan="5">No syncs yet.</td></tr>{/each}
			</tbody>
		</table>
	</section>

	<section class="card p-4 text-sm lg:col-span-2" style="border-color:var(--bad)">
		<h2 class="mb-1 font-medium text-bad">Danger zone</h2>
		<p class="mb-3 text-xs text-muted-foreground">Removes this property from Google Search Console itself (not just from this app). Other users of the property lose it too. This cannot be undone from here.</p>
		<form method="POST" action="?/removeProperty" use:enhance class="flex flex-wrap gap-2">
			<input class="input w-80" name="confirm" aria-label="Type the site name to confirm" placeholder="Type the site name to confirm" />
			<button class="btn btn-danger">Remove from Search Console</button>
		</form>
	</section>
</div>
