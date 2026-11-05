<script lang="ts">
	import '../app.css';
	import { page } from '$app/state';
	let { data, children } = $props();
	const links = [
		['/', 'Dashboard'],
		['/portfolio', 'Portfolio'],
		['/sitemaps', 'Sitemaps'],
		['/connect', 'Connect'],
		['/agents', 'Agents'],
		['/accounts', 'Accounts']
	];
	const active = (href: string) => (href === '/' ? page.url.pathname === '/' || page.url.pathname.startsWith('/sites') : page.url.pathname.startsWith(href));
</script>

<header class="border-b" style="border-color:var(--line);background:var(--panel)">
	<div class="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-6 gap-y-1 px-4 py-2.5">
		<a href="/" class="whitespace-nowrap font-semibold tracking-tight">OpenSiteConsole</a>
		<nav class="order-last flex w-full gap-1 overflow-x-auto sm:order-none sm:w-auto">
			{#each links as [href, label]}
				<a {href} class="rounded-md px-2.5 py-1 text-[13px] {active(href) ? 'bg-black/[.06] font-medium dark:bg-white/10' : 'text-muted hover:text-[color:var(--ink)]'}">{label}</a>
			{/each}
		</nav>
		<div class="ml-auto flex items-center gap-3 text-xs text-muted">
			{#if data.queue.active + data.queue.waiting > 0}<span title="Background syncs">⟳ syncing {data.queue.active + data.queue.waiting}</span>{/if}
			{#if data.demo}<span class="chip">demo data</span>{/if}
			{#if data.readOnly}<span class="chip">read-only</span>{/if}
			{#if data.hasPassword}<form method="POST" action="/logout"><button class="hover:underline">Sign out</button></form>{/if}
		</div>
	</div>
</header>
{#if data.revoked}
	<div class="border-b px-4 py-2 text-sm text-bad" style="border-color:var(--line)">
		{data.revoked} Google account(s) lost access. <a class="underline" href="/accounts">Reconnect</a> to resume syncing.
	</div>
{/if}
<main class="mx-auto max-w-[1400px] px-4 py-5">{@render children()}</main>
