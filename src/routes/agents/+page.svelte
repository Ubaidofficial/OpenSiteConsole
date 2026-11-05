<script lang="ts">
	import { enhance } from '$app/forms';
	import { ago } from '$lib/format';
	let { data, form } = $props();
	const nameOf = (id: number) => data.sites.find((s) => s.id === id)?.name ?? `#${id}`;
</script>

<h1 class="mb-1 text-lg font-semibold">Agents &amp; MCP</h1>
<p class="mb-4 max-w-3xl text-sm text-muted">
	OpenSiteConsole exposes a <b>read-only</b> MCP server, so Claude Code, Claude Desktop, Cursor or any MCP client can query your Search Console, Bing, GA4 and Clarity data.
	Connect it alongside OpenSEO's MCP: ask the agent for a site's <code>get_openseo_project</code> and it can hand that project id to OpenSEO's keyword, rank-tracking and audit tools.
	Nothing here can change a site or spend money.
</p>

{#if form?.newKey}
	<div class="card mb-4 border-[color:var(--good)] p-4">
		<p class="mb-1 text-sm font-medium">Copy your key now — it is shown only once.</p>
		<code class="block break-all rounded bg-black/5 p-2 text-sm dark:bg-white/10">{form.newKey}</code>
		<p class="mt-3 mb-1 text-xs text-muted">Claude Code:</p>
		<pre class="overflow-x-auto rounded bg-black/5 p-2 text-xs dark:bg-white/10">claude mcp add --transport http opensiteconsole {data.mcpUrl} --header "Authorization: Bearer {form.newKey}"</pre>
	</div>
{/if}

<div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
	<section class="card p-4">
		<h2 class="mb-2 font-medium">Create a key</h2>
		<form method="POST" action="?/create" use:enhance class="space-y-3 text-sm">
			<input class="input w-full" name="name" placeholder="Name, e.g. Claude Code (laptop)" required />
			<fieldset>
				<legend class="mb-1 text-xs text-muted">Limit to sites (none ticked = all sites). Out-of-scope sites are invisible to the key.</legend>
				<div class="grid max-h-40 grid-cols-1 gap-1 overflow-y-auto sm:grid-cols-2">
					{#each data.sites as s}<label class="flex items-center gap-2"><input type="checkbox" name="site" value={s.id} /> {s.name}</label>{/each}
				</div>
			</fieldset>
			<button class="btn btn-primary">Create key</button>
		</form>
	</section>

	<section class="card p-4 text-sm">
		<h2 class="mb-2 font-medium">Endpoint</h2>
		<code class="block break-all rounded bg-black/5 p-2 dark:bg-white/10">{data.mcpUrl}</code>
		<p class="mt-2 text-xs text-muted">Send the key as <code>Authorization: Bearer osc_…</code> or <code>x-api-key</code>. Set <code>ORIGIN</code> to your public URL so this shows the right address. Tools: list_sites, get_overview, get_top_queries, get_top_pages, get_opportunities, get_bing_performance, get_ga4_summary, get_clarity_snapshot, get_openseo_project.</p>
	</section>
</div>

<h2 class="mt-6 mb-2 font-medium">Keys</h2>
<div class="card overflow-x-auto">
	<table class="w-full">
		<thead><tr><th class="th">Name</th><th class="th">Key</th><th class="th">Scope</th><th class="th">Last used</th><th class="th"></th></tr></thead>
		<tbody>
			{#each data.keys as k (k.id)}
				<tr>
					<td class="td">{k.name}</td><td class="td"><code>{k.prefix}…</code></td>
					<td class="td text-xs">{k.scope ? k.scope.map(nameOf).join(', ') : 'all sites'}</td>
					<td class="td text-xs text-muted">{k.lastUsedAt ? ago(k.lastUsedAt) : 'never'}</td>
					<td class="td text-right"><form method="POST" action="?/remove" use:enhance onsubmit={(e) => { if (!confirm('Revoke this key?')) e.preventDefault(); }}><input type="hidden" name="id" value={k.id} /><button class="btn btn-danger">Revoke</button></form></td>
				</tr>
			{:else}<tr><td class="td text-muted" colspan="5">No keys yet.</td></tr>{/each}
		</tbody>
	</table>
</div>
