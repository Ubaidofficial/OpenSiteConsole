<script lang="ts">
	/**
	 * How to connect an AI app to this SEOConsole, one tab per app, every step using this instance's own MCP address (ORIGIN + /api/mcp).
	 * Claude signs in with no key; ChatGPT signs in too once its callback address is allowed; Claude Code signs in through a browser
	 * window; Codex and other clients take a key. Menu names in other companies' apps change, so each tab says where to check.
	 */
	let { url, chatgptCallbacks = [], publicOrigin = true }: { url: string; chatgptCallbacks?: string[]; publicOrigin?: boolean } = $props();
	const tabs = [
		['claude', 'Claude'],
		['chatgpt', 'ChatGPT'],
		['code', 'Claude Code'],
		['codex', 'Codex'],
		['other', 'Cursor & others']
	] as const;
	let tab = $state<(typeof tabs)[number][0]>('claude');
	let copied = $state<string | null>(null);
	async function copy(text: string, id: string) {
		try {
			await navigator.clipboard.writeText(text);
			copied = id;
			setTimeout(() => (copied = copied === id ? null : copied), 1500);
		} catch {
			/* the text stays on screen to copy by hand */
		}
	}
	const codeCmd = $derived(`claude mcp add --scope user --transport http seoconsole ${url}`);
	const codexToml = $derived(`[mcp_servers.seoconsole]\nurl = "${url}"\nbearer_token_env_var = "OSC_MCP_KEY"`);
	const otherJson = $derived(`{ "mcpServers": { "seoconsole": { "url": "${url}", "headers": { "Authorization": "Bearer osc_YOUR_KEY" } } } }`);
</script>

{#snippet copyable(text: string, id: string, mono = true)}
	<div class="flex items-stretch gap-2">
		<code class="min-w-0 flex-1 overflow-x-auto rounded-md border bg-muted px-3 py-2 text-[13px] whitespace-pre {mono ? 'font-mono' : ''}">{text}</code>
		<button type="button" class="btn shrink-0 !h-auto text-xs" onclick={() => copy(text, id)}>{copied === id ? 'Copied' : 'Copy'}</button>
	</div>
{/snippet}

<section class="card mb-6 p-5" aria-labelledby="mcp-connect-h">
	<h2 id="mcp-connect-h" class="text-base font-semibold">Connect an AI app</h2>
	<p class="mb-3 text-sm text-muted-foreground">Your MCP server address. Paste it into the app; it signs in to this SEOConsole and reads your search data.</p>
	{@render copyable(url, 'url')}
	{#if !publicOrigin}<p class="mt-2 text-xs text-warn">This address is not a public https address, so Claude and ChatGPT (which connect from the internet) cannot reach it. Set <code>ORIGIN</code> to your public address, or use Claude Code or Codex on this computer.</p>{/if}

	<div class="mt-5 flex flex-wrap gap-1 border-b" role="tablist" aria-label="Choose your app">
		{#each tabs as [id, label]}
			<button type="button" role="tab" aria-selected={tab === id} class="-mb-px border-b-2 px-3 py-2 text-sm {tab === id ? 'border-[color:var(--link)] font-medium' : 'border-transparent text-muted-foreground hover:text-foreground'}" onclick={() => (tab = id)}>{label}</button>
		{/each}
	</div>

	<div class="pt-4 text-sm" role="tabpanel">
		{#if tab === 'claude'}
			<ol class="ml-5 list-decimal space-y-2">
				<li>In Claude (claude.ai or the desktop app), open <b>Settings → Connectors</b> (on some versions <b>Customize → Connectors</b>) and choose <b>Add custom connector</b>.</li>
				<li>Name it <b>SEOConsole</b> and paste the address above as the URL. Leave the advanced settings empty.</li>
				<li>Click <b>Add</b>, then <b>Connect</b>. A SEOConsole page opens: sign in with your admin password, pick which sites Claude may read, and click <b>Allow</b>.</li>
				<li>In a chat, open the tools menu and switch SEOConsole on. Try: <i>“What should I fix first across my sites?”</i></li>
			</ol>
			<div class="mt-4 rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
				<p><b class="text-foreground">“A connector with this URL already exists in your organization”?</b> Someone in your Claude organization (maybe you) already added it. Don't add it again: find <b>SEOConsole</b> in the connectors list and click <b>Connect</b>. On Team and Enterprise plans, an owner adds custom connectors for everyone and each member then connects with their own sign-in.</p>
			</div>
			<p class="mt-3 text-xs text-muted-foreground">No key to paste: the sign-in creates one, it renews itself, and it appears in the keys table below, where one click revokes it. Anthropic moves menu names now and then; their help article on custom connectors has the current path.</p>
		{:else if tab === 'chatgpt'}
			<p class="mb-3 text-xs text-muted-foreground">Custom connectors need a paid ChatGPT plan with developer mode or custom MCP servers switched on, and OpenAI changes these menus often. Check OpenAI's help article on developer mode if a step differs.</p>
			<ol class="ml-5 list-decimal space-y-2">
				<li><b>Allow ChatGPT to sign in (server owner, once).</b> SEOConsole only accepts sign-ins from apps it knows; Claude is built in, ChatGPT is not. Start step 2 until ChatGPT shows its <b>callback / redirect URL</b>, then put that exact address in the <code>MCP_OAUTH_REDIRECTS</code> setting and restart. It is usually <code>https://chatgpt.com/connector_platform_oauth_redirect</code>.
					<p class="mt-1 text-xs {chatgptCallbacks.length ? 'text-good' : 'text-warn'}">{chatgptCallbacks.length ? `Allowed on this server: ${chatgptCallbacks.join(', ')}` : 'Not allowed on this server yet.'}</p>
				</li>
				<li>In ChatGPT, open <b>Settings → Apps &amp; Connectors → Advanced settings</b> and turn on <b>Developer mode</b>, then choose <b>Create</b>. (Newer accounts may show this as <b>Add custom MCP server</b>.)</li>
				<li>Name it <b>SEOConsole</b>, paste the address above as the MCP server URL, choose <b>OAuth</b> for authentication, tick that you trust it, and create it.</li>
				<li>ChatGPT opens the SEOConsole sign-in page: sign in, pick the sites, click <b>Allow</b>. Then in a chat, enable SEOConsole from the <b>+</b> menu.</li>
			</ol>
		{:else if tab === 'code'}
			<p class="mb-2">Run this once in a terminal, on any computer:</p>
			{@render copyable(codeCmd, 'code')}
			<p class="mt-3">Then, inside Claude Code, type <code>/mcp</code>, pick <b>seoconsole</b> and choose to authenticate. A browser window opens for the same sign-in as Claude. <code>--scope user</code> makes it available in every project.</p>
			<p class="mt-2 text-xs text-muted-foreground">Prefer a fixed key? Create one below and add <code>--header "Authorization: Bearer osc_YOUR_KEY"</code> to the command.</p>
		{:else if tab === 'codex'}
			<p class="mb-2">Codex uses a key. Create one in <b>Create a key</b> below, then add this to <code>~/.codex/config.toml</code>:</p>
			{@render copyable(codexToml, 'codex')}
			<p class="mt-2">and put the key in an environment variable:</p>
			<div class="mt-1">{@render copyable('export OSC_MCP_KEY=osc_YOUR_KEY', 'codexenv')}</div>
		{:else}
			<p class="mb-2">Cursor, Windsurf and most other MCP apps take a server URL. If the app offers <b>sign in / OAuth</b>, paste the address above and sign in (for an app on the internet, add its callback address to <code>MCP_OAUTH_REDIRECTS</code> first; apps on your own computer need nothing). Otherwise create a key below and use this shape:</p>
			{@render copyable(otherJson, 'other')}
			<p class="mt-2 text-xs text-muted-foreground">The file name and field names differ between apps; their documentation has the exact place.</p>
		{/if}
	</div>
</section>
