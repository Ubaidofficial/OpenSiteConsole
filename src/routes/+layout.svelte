<script lang="ts">
	import '../app.css';
	import { page } from '$app/state';
	import { Toaster, toast } from 'svelte-sonner';
	import { Bot, LayoutDashboard, Sparkles, Layers, ListChecks, Map as MapIcon, Plug, RefreshCw, UserCog, Users } from '@lucide/svelte';
	import PrivacyToggle from '$lib/components/privacy-toggle.svelte';
	import { pageTitle } from '$lib/titles';
	import { privacy } from '$lib/privacy.svelte';
	import { onMount } from 'svelte';

	onMount(() => privacy.init());

	let { data, children } = $props();
	const links = [
		['/', 'Dashboard', LayoutDashboard],
		['/chat', 'Ask', Sparkles],
		['/actions', 'Actions', ListChecks],
		['/portfolio', 'Portfolio', Layers],
		['/sitemaps', 'Sitemaps', MapIcon],
		['/connect', 'Connect', Plug],
		['/agents', 'MCP', Bot],
		['/accounts', 'Accounts', Users],
		['/team', 'Team', UserCog]
	] as const;
	// Someone limited to some sites gets only the pages that show nothing from other sites (the server refuses the rest).
	const SCOPED_LINKS = new Set(['/', '/chat', '/team']);
	const shown = $derived(data.user?.scoped ? links.filter(([href]) => SCOPED_LINKS.has(href)) : links);
	const active = (href: string) => (href === '/' ? page.url.pathname === '/' || page.url.pathname.startsWith('/sites') : page.url.pathname.startsWith(href));

	// One place turns every form-action result into a toast, so no action finishes silently.
	let seen: unknown = null;
	$effect(() => {
		const f = page.form as Record<string, unknown> | null;
		if (!f || f === seen) return;
		seen = f;
		if (typeof f.error === 'string') toast.error(f.error);
		else if (typeof f.ok === 'string') toast.success(f.ok);
		else if (typeof f.summary === 'string') toast.success(f.summary);
		else if (typeof f.queued === 'number') {
			const q = f as { queued: number; removed?: number; listError?: string | null };
			if (q.listError) toast.error('Could not refresh the property list from Google', { description: q.listError });
			if (q.removed) toast.success(`${q.removed} propert${q.removed === 1 ? 'y' : 'ies'} removed in Search Console no longer show here`);
			if (q.queued === 0) toast('Nothing to queue: every site is already syncing or has no access');
			else toast.success(`Queued ${q.queued} site${q.queued === 1 ? '' : 's'} for sync`);
		}
		else if (typeof f.hidden === 'number') toast.success(`Hid ${f.hidden} duplicate propert${f.hidden === 1 ? 'y' : 'ies'}`);
		else if (typeof f.newKey === 'string') toast.success('API key created. Copy it now; it is shown once.');
	});
</script>

<svelte:head><title>{pageTitle(page.url.pathname)}</title></svelte:head>

<Toaster theme="light" richColors closeButton position="bottom-right" />

<header class="sticky top-0 z-40 border-b bg-background/85 backdrop-blur">
	<div class="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2">
		<a href="/" class="flex items-center gap-2 font-semibold tracking-tight whitespace-nowrap">
			<img src="/brand/mark-glyph.svg" alt="" width="24" height="24" class="size-6" />
			SEOConsole
		</a>
		{#if data.authed}<nav class="order-last flex w-full gap-0.5 overflow-x-auto sm:order-none sm:w-auto" aria-label="Main">
			{#each shown as [href, label, Icon]}
				<a
					{href}
					aria-current={active(href) ? 'page' : undefined}
					class="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium whitespace-nowrap transition-colors {active(href) ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'}"
				>
					<Icon class="size-3.5" />{label}
				</a>
			{/each}
		</nav>{/if}
		<div class="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
			{#if data.queue.active + data.queue.waiting > 0}
				<span class="inline-flex items-center gap-1.5 rounded-md border px-2 py-1" title="Background syncs running"><RefreshCw class="size-3 animate-spin" />{data.queue.active + data.queue.waiting} syncing</span>
			{/if}
			{#if data.demo}<span class="chip">demo data</span>{/if}
			{#if data.readOnly}<span class="chip">read-only</span>{/if}
			{#if data.hasPassword && data.user}
				<a href="/team" class="inline-flex max-w-48 items-center gap-1.5 truncate rounded-md px-2 py-1 hover:bg-accent hover:text-accent-foreground" title={data.user.email ? `Signed in as ${data.user.name} (${data.user.email}), ${data.user.roleLabel}` : `Signed in as the owner`}>
					<span class="truncate"><span class="pii">{data.user.name}</span></span><span class="chip">{data.user.roleLabel}</span>
				</a>
				<form method="POST" action="/logout"><button class="rounded-md px-2 py-1 hover:bg-accent hover:text-accent-foreground">Sign out</button></form>
			{/if}
			<PrivacyToggle />
		</div>
	</div>
</header>
{#if data.user?.role === 'viewer'}
	<div class="border-b bg-accent/40 px-4 py-1.5 text-center text-xs text-muted-foreground">You have view-only access: buttons that change something will be refused.</div>
{/if}
{#if data.revoked}
	<div class="border-b bg-destructive/10 px-4 py-2 text-sm text-destructive">
		{data.revoked} Google account(s) lost access. <a class="font-medium underline" href="/accounts">Reconnect</a> to resume syncing.
	</div>
{/if}
<main class="mx-auto max-w-[1400px] px-4 py-6">{#key page.url.pathname.split('/').slice(1, 3).join('/')}<div class="page-in">{@render children()}</div>{/key}</main>
<footer class="mx-auto max-w-[1400px] px-4 pb-8 text-xs text-muted-foreground"><a class="hover:underline" href="/compare">Compare</a> · <a class="hover:underline" href="/privacy">Privacy policy</a> · <a class="hover:underline" href="/terms">Terms of service</a></footer>
