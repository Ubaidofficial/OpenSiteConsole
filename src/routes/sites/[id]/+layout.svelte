<script lang="ts">
	import { privacy } from '$lib/privacy.svelte';
	import { page } from '$app/state';
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import { ChevronDown, RefreshCw, Sparkles } from '@lucide/svelte';
	import PeriodPicker from '$lib/components/PeriodPicker.svelte';
	import { SITE_PRIMARY_TABS, SITE_TABS, SITE_TAB_GROUPS } from '$lib/explain';
	const tabOf = (t: string) => SITE_TABS.find(([p]) => p === t)!;
	import Delta from '$lib/components/Delta.svelte';
	import SiteAvatar from '$lib/components/SiteAvatar.svelte';
	import { fmtInt, fmtPct, fmtPos, ago } from '$lib/format';

	let { data, children } = $props();
	const syncing = $derived(data.site.syncStatus === 'running' || data.site.syncStatus === 'queued');
	let wasSyncing = false;
	$effect(() => {
		if (syncing) {
			wasSyncing = true;
			const t = setInterval(() => invalidateAll(), 2500);
			return () => clearInterval(t);
		}
		if (wasSyncing) {
			wasSyncing = false;
			if (data.site.syncStatus === 'error') toast.error('Sync failed', { description: privacy.on ? undefined : (data.site.syncMessage ?? undefined) });
			else toast.success('Sync finished');
		}
	});
	const base = $derived(`/sites/${data.site.id}`);
	const isActive = (t: string) => (t === '' ? page.url.pathname === base : page.url.pathname.startsWith(base + t));
	/** A tab from under More that is open right now is shown in the row too, so you can always see where you are. */
	const activeExtra = $derived(SITE_TABS.map(([t]) => t as string).find((t) => t !== '' && isActive(t) && !(SITE_PRIMARY_TABS as readonly string[]).includes(t)) ?? null);
	let moreOpen = $state(false);
	$effect(() => {
		void page.url.pathname;
		moreOpen = false; // close the menu after choosing a tab
		// on a phone the tab row scrolls sideways: bring the open tab into view
		queueMicrotask(() => document.querySelector('nav[aria-label="Site sections"] [aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
	});
	const kpis = $derived([
		{ l: 'Clicks', v: fmtInt(data.kpis.clicks), d: data.kpis.clicksDelta, inv: false },
		{ l: 'Impressions', v: fmtInt(data.kpis.impressions), d: data.kpis.impressionsDelta, inv: false },
		{ l: 'CTR', v: fmtPct(data.kpis.ctr), d: data.kpis.ctrDelta, inv: false },
		{ l: 'Avg position', v: fmtPos(data.kpis.position), d: data.kpis.positionDelta, inv: true, pos: true }
	]);
	/** The product each source tab reads from, shown by its own logo. */
	const SRC_LOGO: Record<string, string> = { '/bing': 'bing.svg', '/analytics': 'ga4.svg', '/tags': 'tag-manager.svg', '/clarity': 'clarity.png', '/vitals': 'chrome.svg' };
</script>

<div class="mb-3 flex flex-wrap items-start gap-3">
	<SiteAvatar name={data.site.label || data.site.name} siteId={data.site.id} class="pii mt-1 !size-9 !rounded-lg !text-sm" />
	<div class="min-w-0">
		<div class="text-xs text-muted-foreground"><a href="/" class="hover:underline">All sites</a> / <span class="pii">{data.account.label ?? data.account.email}</span></div>
		<h1 class="pii truncate text-lg font-semibold">{data.site.label || data.site.name}</h1>
		<div class="text-xs text-muted-foreground">
			<span class="pii">{data.site.url}</span> · {data.period.start} → {data.period.end}
			· {#if data.site.syncStatus === 'running' || data.site.syncStatus === 'queued'}{data.site.syncStatus}…{:else if data.site.syncStatus === 'error'}<span class="text-bad">sync error: {data.site.syncMessage}</span>{:else}synced {ago(data.site.lastSync)}{/if}
			{#if !data.site.backfillDone && data.site.syncedThrough} · backfilling history (back to {data.site.backfilledTo}){/if}
		</div>
	</div>
	<div class="ml-auto flex flex-wrap items-center gap-3">
		<PeriodPicker days={data.days} />
		{#if data.openseo?.url}<a class="btn" href={data.openseo.url} target="_blank" rel="noreferrer noopener" title={privacy.on ? undefined : `OpenSEO project: ${data.openseo.name}`}>OpenSEO ↗</a>{/if}
		<a class="btn" href="/chat?draft={encodeURIComponent(`About ${data.site.name}: `)}" title="Open the chat with this site named in the question"><Sparkles class="size-3.5" />Ask about this site</a>
		<form method="POST" action="{base}/sync" use:enhance><button class="btn" disabled={syncing}><RefreshCw class="size-3.5 {syncing ? 'animate-spin' : ''}" />{syncing ? 'Syncing…' : 'Sync'}</button></form>
	</div>
</div>

<!-- The totals live on Overview only: every other tab is a table that already has these columns. -->
{#if isActive('')}
<div class="stagger mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
	{#each kpis as k}
		<div class="card px-3 py-2">
			<div class="text-xs text-muted-foreground">{k.l}</div>
			<div class="tnum text-xl font-semibold">{k.v}</div>
			<Delta value={k.d} invert={k.inv} mode={k.pos ? 'pos' : 'pct'} why={data.kpis.comparable ? 'Too little data for a reliable comparison' : 'Previous period still downloading'} />{#if k.d != null && k.pos}<span class="ml-1 text-xs text-muted-foreground">places</span>{/if}
		</div>
	{/each}
</div>
{/if}

<!-- A short row of the tabs people use most; the rest are one click away under More, grouped, each with a line on what it is for. -->
{#snippet tabLogo(t: string)}{#if SRC_LOGO[t]}<img src="/logos/{SRC_LOGO[t]}" alt="" width="14" height="14" class="mr-1.5 inline-block size-3.5 align-[-2px] object-contain" />{/if}{/snippet}
{#snippet tabBadges(t: string)}{#if t === '/actions' && data.actionBadge.open}<span class="ml-1.5 inline-grid min-w-4 place-items-center rounded-full px-1 text-[10px] font-semibold {data.actionBadge.blocking ? 'bg-[color:var(--bad)] text-white' : 'bg-muted text-muted-foreground'}" title="{data.actionBadge.open} open{data.actionBadge.blocking ? ', ' + data.actionBadge.blocking + ' blocking' : ''}">{data.actionBadge.open}</span>{/if}{#if (t === '/bing' && data.linked.bing) || (t === '/analytics' && data.linked.ga4) || (t === '/tags' && data.linked.gtm) || (t === '/clarity' && data.linked.clarity)}<span class="ml-1 text-good" title="connected">●</span>{/if}{/snippet}
{#snippet tab(t: string)}
	{@const [, label, about] = tabOf(t)}
	<a href="{base}{t}?days={data.days}" title={about} aria-current={isActive(t) ? 'page' : undefined} class="-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-[13px] transition-colors duration-150 {isActive(t) ? 'border-[color:var(--link)] font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}">{@render tabLogo(t)}{label}{@render tabBadges(t)}</a>
{/snippet}
<nav class="relative mb-5 flex items-end border-b" style="border-color:var(--border)" aria-label="Site sections">
	<!-- one line on every screen: the tabs scroll sideways on a phone, and More stays put outside the scrolling part -->
	<div class="-mb-px flex min-w-0 flex-1 items-end overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
		{#each SITE_PRIMARY_TABS as t}{@render tab(t)}{/each}
		{#if activeExtra}{@render tab(activeExtra)}{/if}
	</div>
	<details class="group shrink-0" bind:open={moreOpen}>
		<summary class="-mb-px flex cursor-pointer list-none items-center gap-1 border-b-2 border-transparent bg-background px-3 py-2 text-[13px] text-muted-foreground select-none hover:text-foreground [&::-webkit-details-marker]:hidden">More<ChevronDown class="size-3.5 transition-transform group-open:rotate-180" /></summary>
		<div class="absolute top-full right-0 left-0 z-30 mt-2 grid gap-x-6 gap-y-4 rounded-xl border bg-card p-4 shadow-lg sm:grid-cols-2 lg:grid-cols-4">
			{#each SITE_TAB_GROUPS as [caption, paths]}
				{@const rest = paths.filter((t) => !(SITE_PRIMARY_TABS as readonly string[]).includes(t))}
				{#if rest.length}
					<div role="group" aria-label={caption}>
						<div class="mb-1.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">{caption}</div>
						<ul class="space-y-0.5">
							{#each rest as t}
								{@const [, label, about] = tabOf(t)}
								<li><a href="{base}{t}?days={data.days}" class="block rounded-md px-2 py-1.5 hover:bg-muted {isActive(t) ? 'bg-muted' : ''}"><span class="text-[13px] font-medium">{@render tabLogo(t)}{label}{@render tabBadges(t)}</span><span class="block text-xs leading-snug text-muted-foreground">{about}</span></a></li>
							{/each}
						</ul>
					</div>
				{/if}
			{/each}
		</div>
	</details>
</nav>

{#key page.url.pathname + '|' + (page.url.searchParams.get('view') ?? '')}<div class="page-in">{@render children()}</div>{/key}
