<script lang="ts">
	import { enhance } from '$app/forms';
	let { data, form } = $props();
	let scope = $state<'all' | 'selected'>('all');
	let done = $state(false);
	const onComputer = $derived(/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(data.redirectHost));
</script>

<div class="mx-auto mt-16 max-w-md">
	<h1 class="mb-1 text-xl font-semibold">Allow access to SEOConsole?</h1>
	<p class="mb-4 text-sm text-muted-foreground">
		<b>{data.clientName}</b> (the name the app gave itself) wants to read your search data. It will be sent back to
		<b class="font-mono">{data.redirectHost}</b>{onComputer ? ', an app running on this computer' : ''}. Only continue if you started this from that app.
	</p>

	{#if done}
		<p class="text-sm">Returning to the app… If nothing happens, you can close this tab.</p>
	{:else}
		<form
			method="POST"
			action="?/allow"
			class="space-y-4"
			use:enhance={() =>
				async ({ result, update }) => {
					if (result.type === 'success' && result.data && typeof result.data.redirect === 'string') {
						done = true;
						window.location.assign(result.data.redirect);
						return;
					}
					await update({ reset: false });
				}}
		>
			<input type="hidden" name="request_id" value={data.requestId} />
			<fieldset class="space-y-2 text-sm">
				<legend class="mb-1 font-medium">Which sites can it read?</legend>
				<label class="flex items-center gap-2"><input type="radio" name="scope" value="all" bind:group={scope} /> All sites</label>
				<label class="flex items-center gap-2"><input type="radio" name="scope" value="selected" bind:group={scope} /> Only these:</label>
				{#if scope === 'selected'}
					<div class="ml-6 space-y-1">
						{#each data.sites as s}<label class="flex items-center gap-2"><input type="checkbox" name="site" value={s.id} /> <span class="pii">{s.name}</span></label>{/each}
					</div>
				{/if}
			</fieldset>
			<fieldset class="space-y-1.5 text-sm">
				<legend class="mb-1 font-medium">What may it do?</legend>
				<label class="flex items-start gap-2"><input type="radio" name="level" value="read" checked class="mt-1" /> <span><b>Read only</b> (default): look at your search, analytics and indexing data.</span></label>
				<label class="flex items-start gap-2"><input type="radio" name="level" value="submit" class="mt-1" disabled={data.readOnly} /> <span><b>Also submit</b>: send URLs and sitemaps to search engines (IndexNow, Bing, Search Console), start an indexing check, and make the app's own changes (mark findings done, log a change, start a test, refresh data, watch URLs).</span></label>
				<label class="flex items-start gap-2"><input type="radio" name="level" value="delete" class="mt-1" disabled={data.readOnly} /> <span><b>Submit and delete</b>: also remove a sitemap from Search Console and throw away queued submissions. Each of those needs a second, confirming call.</span></label>
				{#if data.readOnly}<p class="text-xs text-warn">Only read access is available: this server runs with READ_ONLY=1.</p>{/if}
				<p class="text-xs text-muted-foreground">It still cannot delete your data or change a site's content or settings.</p>
			</fieldset>
			<p class="text-xs text-muted-foreground">Unless you pick a higher level above, access is read-only: it can look at your Search Console, GA4, Bing and indexing data, and cannot change anything. You can remove it any time on the MCP page.</p>
			{#if form?.error}<p class="text-sm text-bad">{form.error}</p>{/if}
			<div class="flex gap-2">
				<button class="btn btn-primary">Allow</button>
				<button class="btn" formaction="?/deny" formnovalidate>Deny</button>
			</div>
		</form>
	{/if}
</div>
