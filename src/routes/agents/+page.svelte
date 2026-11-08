<script lang="ts">
	import { ConfirmButton } from '$lib/components/ui/confirm';
	import { enhance } from '$app/forms';
	import { ago } from '$lib/format';
	import Explainer from '$lib/components/Explainer.svelte';
	import McpGuide from '$lib/components/McpGuide.svelte';
	let { data, form } = $props();
	const nameOf = (id: number) => data.sites.find((s) => s.id === id)?.name ?? `#${id}`;
</script>

<h1 class="mb-1 text-lg font-semibold">MCP</h1>
<Explainer lead="Connect Claude, ChatGPT or any MCP app to your search data. It reads by default, and changes things only where you allow it.">
	<p>SEOConsole is an MCP server: an AI app can query your Search Console, GA4, Tag Manager, Bing, Clarity and Core Web Vitals data in one place. Connect it next to OpenSEO's MCP: <code>get_openseo_project</code> hands a site's project id to OpenSEO's keyword, rank-tracking and audit tools.</p>
	<p>A key can also be given the <b>submit</b> permission (push URLs and sitemaps to IndexNow, Bing, Search Console and, for job and livestream pages, Google's Indexing API; start an indexing check), or <b>submit and delete</b>, which adds the few actions that cannot be undone and need a confirming second call. Nothing can delete your data or change a site's content.</p>
	<p>The table at the bottom lists every change an app made, and every time a key was given or lost a permission.</p>
</Explainer>

<McpGuide url={data.mcpUrl} chatgptCallbacks={data.chatgptCallbacks} publicOrigin={data.publicOrigin} />

{#if form?.newKey}
	<div class="card mb-4 border-[color:var(--good)] p-4">
		<p class="mb-1 text-sm font-medium">Copy your key now — it is shown only once.{#if form.newKeyPermission === 'delete'} <span class="chip ml-1">can submit and delete</span>{:else if form.newKeyPermission === 'submit'} <span class="chip ml-1">can submit URLs &amp; sitemaps</span>{:else} <span class="chip ml-1">read-only</span>{/if}</p>
		<code class="block break-all rounded bg-black/5 p-2 text-sm dark:bg-white/10">{form.newKey}</code>
		<p class="mt-3 mb-1 text-xs text-muted-foreground">Claude Code:</p>
		<!-- svelte-ignore a11y_no_noninteractive_tabindex: a scrollable code block must be reachable by keyboard -->
		<pre tabindex="0" class="overflow-x-auto rounded bg-black/5 p-2 text-xs dark:bg-white/10">claude mcp add --transport http seoconsole {data.mcpUrl} --header "Authorization: Bearer {form.newKey}"</pre>
	</div>
{/if}

<div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
	<section class="card p-4">
		<h2 class="mb-2 font-medium">Create a key</h2>
		<form method="POST" action="?/create" use:enhance class="space-y-3 text-sm">
			<input class="input w-full" name="name" placeholder="Name, e.g. Claude Code (laptop)" required />
			<fieldset>
				<legend class="mb-1 text-xs text-muted-foreground">Limit to sites (none ticked = all sites). Out-of-scope sites are invisible to the key.</legend>
				<div class="grid max-h-40 grid-cols-1 gap-1 overflow-y-auto sm:grid-cols-2">
					{#each data.sites as s}<label class="flex items-center gap-2"><input type="checkbox" name="site" value={s.id} /> <span class="pii">{s.name}</span></label>{/each}
				</div>
			</fieldset>
			<fieldset class="space-y-1.5 rounded border p-2 text-xs" style="border-color:var(--border)">
				<legend class="px-1 text-muted-foreground">What may the key do?</legend>
				<label class="flex items-start gap-2"><input type="radio" name="permission" value="read" checked class="mt-0.5" /> <span><b>Read only</b> (default).</span></label>
				<label class="flex items-start gap-2"><input type="radio" name="permission" value="submit" class="mt-0.5" disabled={data.readOnly} /> <span><b>Submit</b>: also send URLs and sitemaps to search engines, set up IndexNow, ask for checks and record Request-list actions ({data.writeTools.submit.join(', ')}). Limited per day by <code>MCP_SUBMIT_PER_KEY_DAY</code>.</span></label>
				<label class="flex items-start gap-2"><input type="radio" name="permission" value="delete" class="mt-0.5" disabled={data.readOnly} /> <span><b>Submit and delete</b>: also {data.writeTools.delete.join(' and ')}. Each needs a second, confirming call with a single-use token.</span></label>
				{#if data.readOnly}<p class="text-warn"><b>Disabled: this server runs with READ_ONLY=1.</b></p>{/if}
			</fieldset>
			<button class="btn btn-primary">Create key</button>
		</form>
	</section>

	<section class="card p-4 text-sm">
		<h2 class="mb-2 font-medium">Using a key</h2>
		<p class="mt-2 text-xs text-muted-foreground">Send the key as <code>Authorization: Bearer osc_…</code> or <code>x-api-key</code>. Set <code>ORIGIN</code> to your public URL so this shows the right address.</p>
		<p class="mt-2 text-xs text-muted-foreground"><b>{data.tools.length} tools</b> ({data.tools.length - data.changeTools.length} only read; {data.writeTools.submit.length} need submit, {data.writeTools.delete.length} need delete): <span class="font-mono">{data.tools.join(', ')}</span>.</p>
	</section>
</div>



<h2 class="mt-6 mb-2 font-medium">Keys</h2>
<div class="card overflow-x-auto">
	<table class="w-full">
		<thead><tr><th class="th">Name</th><th class="th">Key</th><th class="th">Scope</th><th class="th">Can change things</th><th class="th">Last used</th><th class="th relative"><span class="sr-only">Actions</span></th></tr></thead>
		<tbody>
			{#each data.keys as k (k.id)}
				<tr>
					<td class="td">{k.name}{#if k.permission === 'submit'}<span class="chip ml-2 !border-[color:var(--warn)]" title="This key may push URLs and sitemaps to search engines.">can submit</span>{:else if k.permission === 'delete'}<span class="chip ml-2 !border-[color:var(--bad)] text-bad" title="This key may also remove a sitemap from Search Console and discard queued submissions (each after a confirming second call).">can submit + delete</span>{/if}{#if k.signInApp}<span class="chip ml-2" title="Created when {k.signInApp} was approved with Sign in. Its token is renewed automatically; revoke it here to cut the app off.">sign-in</span>{/if}</td><td class="td"><code>{k.prefix}…</code></td>
					<td class="td text-xs"><span class="pii">{k.scope ? k.scope.map(nameOf).join(', ') : 'all sites'}</span></td>
					<td class="td text-xs"><form method="POST" action="?/permission" use:enhance={() => async ({ update }) => update({ reset: false })} class="flex items-center gap-2"><input type="hidden" name="id" value={k.id} /><label class="sr-only" for="lvl-{k.id}">Permission for {k.name}</label><select id="lvl-{k.id}" name="level" aria-label="Permission for {k.name}" class="input text-xs" disabled={data.readOnly}><option value="read" selected={k.permission === 'read'}>Read only</option><option value="submit" selected={k.permission === 'submit'}>Submit</option><option value="delete" selected={k.permission === 'delete'}>Submit and delete</option></select><button class="btn text-xs">Save</button></form></td>
					<td class="td text-xs text-muted-foreground">{k.lastUsedAt ? ago(k.lastUsedAt) : 'never'}</td>
					<td class="td text-right"><form method="POST" action="?/remove" use:enhance><input type="hidden" name="id" value={k.id} /><ConfirmButton title="Revoke this API key?" description="Anything using this key (an agent, a script) loses access immediately." confirmLabel="Revoke key">Revoke</ConfirmButton></form></td>
				</tr>
			{:else}<tr><td class="td text-muted-foreground" colspan="6">No keys yet.</td></tr>{/each}
		</tbody>
	</table>
</div>

<h2 class="mt-8 mb-1 font-medium">Agent activity</h2>
<p class="mb-2 text-xs text-muted-foreground">Every change an agent made through the MCP, and every time a key or sign-in was given or taken away the right to make changes. Newest first.</p>
<div class="card overflow-x-auto">
	<table class="w-full">
		<thead><tr><th class="th">When</th><th class="th">What</th><th class="th">Site</th><th class="th">Details</th></tr></thead>
		<tbody>
			{#each data.activity as a}
				<tr>
					<td class="td whitespace-nowrap text-xs text-muted-foreground">{ago(a.at)}</td>
					<td class="td text-xs"><code>{a.action.replace(/^mcp\./, '')}</code></td>
					<td class="td text-xs"><span class="pii">{a.siteId ? nameOf(a.siteId) : ''}</span></td>
					<td class="td max-w-[40rem] truncate text-xs text-muted-foreground"><span class="pii" title={a.detail ?? ''}>{a.detail ?? ''}</span></td>
				</tr>
			{:else}<tr><td class="td text-muted-foreground" colspan="4">Nothing yet.</td></tr>{/each}
		</tbody>
	</table>
</div>
