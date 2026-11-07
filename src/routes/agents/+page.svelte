<script lang="ts">
	import { ConfirmButton } from '$lib/components/ui/confirm';
	import { enhance } from '$app/forms';
	import { ago } from '$lib/format';
	let { data, form } = $props();
	const nameOf = (id: number) => data.sites.find((s) => s.id === id)?.name ?? `#${id}`;
</script>

<h1 class="mb-1 text-lg font-semibold">Agents &amp; MCP</h1>
<p class="mb-4 max-w-3xl text-sm text-muted-foreground">
	SEOConsole exposes a <b>read-only</b> MCP server, so Claude Code, Claude Desktop, Cursor or any MCP client can query your Search Console, GA4, Google Tag Manager, Bing, Clarity and Core Web Vitals data in one place. <code>get_tracking_health</code> cross-checks Search Console, GA4 and Tag Manager for a site, <code>get_trends</code> and <code>get_content_groups</code> cover movement and structure, <code>get_seo_tests</code> reads test results, and <code>get_connections</code> shows which tools are connected.
	Connect it alongside OpenSEO's MCP: ask the agent for a site's <code>get_openseo_project</code> and it can hand that project id to OpenSEO's keyword, rank-tracking and audit tools.
	Nothing here can change a site or spend money.
</p>

{#if form?.newKey}
	<div class="card mb-4 border-[color:var(--good)] p-4">
		<p class="mb-1 text-sm font-medium">Copy your key now — it is shown only once.</p>
		<code class="block break-all rounded bg-black/5 p-2 text-sm dark:bg-white/10">{form.newKey}</code>
		<p class="mt-3 mb-1 text-xs text-muted-foreground">Claude Code:</p>
		<pre class="overflow-x-auto rounded bg-black/5 p-2 text-xs dark:bg-white/10">claude mcp add --transport http seoconsole {data.mcpUrl} --header "Authorization: Bearer {form.newKey}"</pre>
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
			<button class="btn btn-primary">Create key</button>
		</form>
	</section>

	<section class="card p-4 text-sm">
		<h2 class="mb-2 font-medium">Endpoint</h2>
		<code class="block break-all rounded bg-black/5 p-2 dark:bg-white/10">{data.mcpUrl}</code>
		<p class="mt-2 text-xs text-muted-foreground">Send the key as <code>Authorization: Bearer osc_…</code> or <code>x-api-key</code>. Set <code>ORIGIN</code> to your public URL so this shows the right address.</p>
		<p class="mt-2 text-xs text-muted-foreground"><b>{data.tools.length} tools:</b> <span class="font-mono">{data.tools.join(', ')}</span>.</p>
	</section>
</div>

<h2 class="mt-6 mb-2 font-medium">Connect your AI client</h2>
<p class="mb-3 max-w-3xl text-xs text-muted-foreground">Replace <code>osc_YOUR_KEY</code> with a key from above. The key is a bearer token. Claude (the apps) and ChatGPT reach the server from the internet, so for them the app needs a public https address; Claude Code and Codex run on your computer and can use <code>http://localhost</code>.</p>
<div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
	<section class="card p-4 text-sm">
		<h3 class="mb-1 font-medium">Claude Code</h3>
		<pre class="overflow-x-auto rounded bg-black/5 p-2 text-xs dark:bg-white/10">claude mcp add --transport http seoconsole {data.mcpUrl} --header "Authorization: Bearer osc_YOUR_KEY"</pre>
	</section>
	<section class="card p-4 text-sm">
		<h3 class="mb-1 font-medium">Claude (claude.ai and the desktop app)</h3>
		<p class="text-xs text-muted-foreground">Settings → Connectors → add a custom connector. URL: <code>{data.mcpUrl}</code>. Authentication: no sign-in. Under request headers add <code>Authorization</code> with the value <code>Bearer osc_YOUR_KEY</code>. Anthropic's help article describes custom connectors with fixed header credentials; the menu names move around, so follow their current article if a label differs. Custom connectors are not on every plan.</p>
	</section>
	<section class="card p-4 text-sm">
		<h3 class="mb-1 font-medium">Codex</h3>
		<p class="mb-1 text-xs text-muted-foreground">In <code>~/.codex/config.toml</code> (or a trusted project's <code>.codex/config.toml</code>), with the key in an environment variable:</p>
		<pre class="overflow-x-auto rounded bg-black/5 p-2 text-xs dark:bg-white/10">[mcp_servers.seoconsole]
url = "{data.mcpUrl}"
bearer_token_env_var = "OSC_MCP_KEY"</pre>
		<pre class="mt-1 overflow-x-auto rounded bg-black/5 p-2 text-xs dark:bg-white/10">export OSC_MCP_KEY=osc_YOUR_KEY</pre>
	</section>
	<section class="card p-4 text-sm">
		<h3 class="mb-1 font-medium">ChatGPT</h3>
		<p class="text-xs text-muted-foreground"><b>May not work.</b> ChatGPT's custom connectors (Developer Mode) are reported to expect OAuth sign-in, and SEOConsole authenticates with a bearer key instead; whether your plan offers a bearer-token field is unverified. Use Claude, Claude Code or Codex if ChatGPT will not accept the key.</p>
	</section>
	<section class="card p-4 text-sm lg:col-span-2">
		<h3 class="mb-1 font-medium">Cursor and other clients</h3>
		<p class="mb-1 text-xs text-muted-foreground">Clients that take a server URL plus headers usually accept this shape (check your client's documentation for the exact file and field names):</p>
		<pre class="overflow-x-auto rounded bg-black/5 p-2 text-xs dark:bg-white/10">{`{ "mcpServers": { "seoconsole": { "url": "${data.mcpUrl}", "headers": { "Authorization": "Bearer osc_YOUR_KEY" } } } }`}</pre>
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
					<td class="td text-xs"><span class="pii">{k.scope ? k.scope.map(nameOf).join(', ') : 'all sites'}</span></td>
					<td class="td text-xs text-muted-foreground">{k.lastUsedAt ? ago(k.lastUsedAt) : 'never'}</td>
					<td class="td text-right"><form method="POST" action="?/remove" use:enhance><input type="hidden" name="id" value={k.id} /><ConfirmButton title="Revoke this API key?" description="Anything using this key (an agent, a script) loses access immediately." confirmLabel="Revoke key">Revoke</ConfirmButton></form></td>
				</tr>
			{:else}<tr><td class="td text-muted-foreground" colspan="5">No keys yet.</td></tr>{/each}
		</tbody>
	</table>
</div>
