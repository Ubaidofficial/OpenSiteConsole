<script lang="ts">
	import Explainer from '$lib/components/Explainer.svelte';
	import { enhance } from '$app/forms';
	import { ConfirmButton } from '$lib/components/ui/confirm';
	import { ago } from '$lib/format';
	let { data, form } = $props();
	const tone: Record<string, string> = { core: 'text-bad', spam: 'text-warn', discover: 'text-muted-foreground', other: 'text-muted-foreground' };
</script>

<h1 class="mb-1 text-lg font-semibold">Google ranking updates</h1>
<Explainer lead="Google's ranking updates, marked on every chart and flagged on any SEO test they overlap.">
	<p>Core, spam and Discover updates are marked on every site's chart and flagged on any SEO test that overlaps one, because an update can move a section of a site for reasons unrelated to your change.
	The list is read from Google's own <a class="underline" href="https://status.search.google.com/" target="_blank" rel="noreferrer noopener">Search Status Dashboard</a> once a day. That dashboard keeps only recent history, so the app keeps every update it has seen; add older ones by hand.
	Dates are the UTC date of Google's timestamp; Search Console days are Pacific time, so an update can look a day off.</p>
</Explainer>

<section class="card mb-5 p-4">
	<div class="flex flex-wrap items-center gap-3">
		<form method="POST" action="?/import" use:enhance><button class="btn btn-primary">Check Google now</button></form>
		<span class="text-xs text-muted-foreground">{data.checkedAt ? 'last checked ' + ago(data.checkedAt) : 'not checked yet'}</span>
	</div>
	{#if form?.ok}<p class="mt-2 text-sm text-good">{form.ok}</p>{/if}{#if form?.error}<p class="mt-2 text-sm text-bad">{form.error}</p>{/if}
	<form method="POST" action="?/add" use:enhance class="mt-4 flex flex-wrap items-end gap-2 border-t pt-3" style="border-color:var(--border)">
		<label class="text-xs text-muted-foreground">Add an older update<input class="input mt-1 block w-72" name="name" placeholder="e.g. March 2025 core update" required /></label>
		<label class="text-xs text-muted-foreground">Started<input class="input mt-1 block" type="date" name="begin" required /></label>
		<label class="text-xs text-muted-foreground">Finished (optional)<input class="input mt-1 block" type="date" name="end" /></label>
		<button class="btn">Add</button>
	</form>
</section>

<div class="card overflow-x-auto">
	<table class="w-full">
		<thead><tr><th class="th">Update</th><th class="th">Type</th><th class="th">Started</th><th class="th">Finished</th><th class="th">Source</th><th class="th relative"><span class="sr-only">Actions</span></th></tr></thead>
		<tbody>
			{#each data.updates as u (u.id)}
				<tr>
					<td class="td font-medium">{u.name}</td><td class="td text-xs {tone[u.kind]}">{u.kind}</td>
					<td class="td tnum text-xs">{u.begin}</td><td class="td tnum text-xs">{u.end ?? 'rolling out'}</td>
					<td class="td text-xs text-muted-foreground">{u.source === 'google' ? 'Google' : 'added by hand'}</td>
					<td class="td text-right">{#if u.source === 'manual'}<form method="POST" action="?/remove" use:enhance><input type="hidden" name="id" value={u.id} /><ConfirmButton title="Remove this update?" description="Only your own entry is removed." confirmLabel="Remove">Remove</ConfirmButton></form>{/if}</td>
				</tr>
			{:else}<tr><td class="td text-muted-foreground" colspan="6">None yet. Click “Check Google now”.</td></tr>{/each}
		</tbody>
	</table>
</div>
