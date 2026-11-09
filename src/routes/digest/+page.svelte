<script lang="ts">
	import Explainer from '$lib/components/Explainer.svelte';
	import { enhance } from '$app/forms';
	import { ago, fmtInt, fmtSigned } from '$lib/format';
	import { NAMES_TARGETS, type ActionType } from '$lib/actions';
	import { monthSentence } from '$lib/digest';
	let { data, form } = $props();
	const d = $derived(data.shown?.digest ?? null);
	const label = (k: string) => ({ deindexed: 'dropped from index', indexed: 'now indexed', canonical_changed: 'canonical changed', blocked: 'blocked by robots.txt', unblocked: 'unblocked', fetch_error: 'fetch problem' })[k] ?? k;
</script>

<div class="mb-1 flex flex-wrap items-center gap-3">
	<h1 class="text-lg font-semibold">Weekly digest</h1>
	<span class="chip {data.webhook.configured ? 'chip-on' : ''}" title={data.webhook.configured ? `Sent to your webhook (${data.webhook.format} format)` : 'Set DIGEST_WEBHOOK_URL in .env to send digests and alerts to Slack, Discord or any webhook'}>{data.webhook.configured ? 'webhook on' : 'no webhook'}</span>
	<form method="POST" action="?/generate" use:enhance class="ml-auto"><button class="btn btn-primary">Generate now</button></form>
</div>
<Explainer lead="What changed this week and what to do first.">
	<p>What changed this week and what to do first, made automatically once a week (Monday by default; <code>DIGEST_DAY</code>) and sent to your webhook if one is set. Blocking problems are also announced as <b>alerts</b> as soon as they are found, once each.
	There is no email: set <code>DIGEST_WEBHOOK_URL</code> for Slack or Discord, or use the raw JSON format with a service that forwards to email.</p>
</Explainer>
{#if form?.ok}<p class="mb-3 text-sm text-good">{form.ok}</p>{/if}{#if form?.error}<p class="mb-3 text-sm text-bad">{form.error}</p>{/if}

{#if !d}
	<div class="card p-6 text-center text-sm text-muted-foreground">No digest has been made yet. The first one appears on the next digest day, or click “Generate now”.</div>
{:else}
	<p class="mb-2 text-xs text-muted-foreground">Week ending {d.weekEnd} · made {ago(data.shown!.createdAt)}{data.shown!.delivery === 'sent' ? ' · sent to the webhook' : data.shown!.delivery === 'failed' ? ` · sending failed: ${data.shown!.message}` : ''}</p>
	<section class="card mb-4 p-4">
		<ul class="pii space-y-1.5 text-sm">{#each d.headline as h}<li>• {h}</li>{/each}</ul>
		{#if data.webhook.configured}<form method="POST" action="?/send" use:enhance class="mt-3"><input type="hidden" name="id" value={data.shown!.id} /><button class="btn !h-8 text-xs">Send this digest to the webhook</button></form>{/if}
	</section>

	{#if d.top.length}
		<h2 class="mb-1 font-medium">Do this first</h2>
		<div class="card mb-5 overflow-x-auto"><table class="w-full"><tbody>
			{#each d.top as t, i}
				<tr><td class="td tnum w-8 text-muted-foreground">{i + 1}</td>
					<td class="td"><a class="hover:underline" class:pii={NAMES_TARGETS.has(t.type as ActionType)} href={t.href}>{t.title}</a>{#if t.blocking}<span class="chip ml-2 border-[color:var(--bad)] text-bad">blocking</span>{/if}</td>
					<td class="td pii text-xs text-muted-foreground">{t.site}</td>
					<td class="td tnum whitespace-nowrap text-right text-xs">{t.impact != null ? `≈ ${fmtInt(t.impact)} clicks / 28d` : 'no estimate'}</td></tr>
			{/each}
		</tbody></table></div>
	{/if}

	<h2 class="mb-1 font-medium">Site by site</h2>
	<div class="stagger space-y-3">
		{#each d.sites as s (s.siteId)}
			<article class="card p-4 text-sm">
				<div class="flex flex-wrap items-baseline gap-x-4 gap-y-1">
					<a class="pii font-medium hover:underline" href="/sites/{s.siteId}/actions">{s.name}</a>
					{#if s.comparable}
						<span class="tnum">{fmtInt(s.clicks.now)} clicks <span class="{s.clicks.change == null ? '' : s.clicks.significant ? (s.clicks.change > 0 ? 'text-good' : 'text-bad') : 'text-muted-foreground'}">{s.clicks.change == null ? '' : fmtSigned(s.clicks.change)}</span> <span class="text-xs text-muted-foreground">{s.clicks.significant ? 'a real change' : 'within normal wobble'}</span></span>
					{:else}<span class="text-xs text-muted-foreground">not compared yet (previous week still downloading or empty)</span>{/if}
					<span class="ml-auto text-xs text-muted-foreground">{s.openActions} open{#if s.blockingActions} · <b class="text-bad">{s.blockingActions} blocking</b>{/if}</span>
				</div>
				{#if s.queryWinners.length || s.queryLosers.length}
					<div class="mt-2 grid gap-x-6 gap-y-1 text-xs md:grid-cols-2">
						{#if s.queryWinners.length}<div><span class="text-good">Up:</span> {#each s.queryWinners as m}<span class="pii mr-2">{m.key} (+{m.change})</span>{/each}</div>{/if}
						{#if s.queryLosers.length}<div><span class="text-bad">Down:</span> {#each s.queryLosers as m}<span class="pii mr-2">{m.key} ({m.change})</span>{/each}</div>{/if}
					</div>
				{/if}
				{#if s.events.length}<div class="mt-2 text-xs text-muted-foreground">Indexing: {#each s.events.slice(0, 4) as e}<span class="pii mr-2">{label(e.kind)}: {e.url.replace(/^https?:\/\/(www\.)?/, '')}</span>{/each}</div>{/if}
				{#each s.decidedTests as t}<div class="mt-1 text-xs"><span class={t.verdict === 'positive' ? 'text-good' : 'text-bad'}>Test “{t.name}” likely {t.verdict === 'positive' ? 'worked' : 'hurt'}</span>{t.lift != null ? ` (${fmtSigned(t.lift)} vs control)` : ''}</div>{/each}
			</article>
		{/each}
	</div>
{/if}

<section id="monthly" class="mt-8 scroll-mt-20">
	<div class="mb-1 flex flex-wrap items-center gap-3">
		<h2 class="text-base font-semibold">Monthly report</h2>
		<form method="POST" action="?/monthly" use:enhance class="ml-auto"><button class="btn !h-8 text-xs">Make last month's report</button></form>
	</div>
	<Explainer lead="Last calendar month in plain sentences, ready to forward.">
		<p>Made on the 4th of each month (Search Console data lags by about two days), stored here and sent to the same webhook as the digest; <code>DIGEST_MONTHLY=0</code> turns it off. Months differ in length, so changes are compared per day, against the month before and the same month last year once that is stored, and are called real only when they are bigger than normal variation.</p>
	</Explainer>
	{#if data.monthly.shown?.monthly}
		{@const m = data.monthly.shown.monthly}
		<p class="mb-2 text-xs text-muted-foreground">{m.label} · made {ago(data.monthly.shown.createdAt)}{data.monthly.shown.delivery === 'sent' ? ' · sent to the webhook' : data.monthly.shown.delivery === 'failed' ? ` · sending failed: ${data.monthly.shown.message}` : ''}</p>
		<div class="card p-4 text-sm">
			<ul class="pii space-y-1.5">{#each m.headline as h}<li>• {h}</li>{/each}</ul>
			{#if m.sites.length}<ul class="pii mt-3 space-y-1.5 border-t pt-3 text-xs" style="border-color:var(--border)">{#each m.sites as s (s.siteId)}<li>{monthSentence(s, m.month)}</li>{/each}</ul>{/if}
			{#if data.webhook.configured}<form method="POST" action="?/sendMonthly" use:enhance class="mt-3"><input type="hidden" name="id" value={data.monthly.shown.id} /><button class="btn !h-8 text-xs">Send this report to the webhook</button></form>{/if}
		</div>
		{#if data.monthly.history.length > 1}<p class="mt-2 text-xs text-muted-foreground">Earlier: {#each data.monthly.history.slice(1) as h (h.id)}<a class="mr-3 hover:underline" href="?month={h.id}#monthly">{h.label}</a>{/each}</p>{/if}
	{:else}
		<div class="card p-4 text-sm text-muted-foreground">No monthly report yet. The first is made on the 4th of next month, or now with “Make last month's report”.</div>
	{/if}
</section>

<div class="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
	<section>
		<div class="mb-1 flex items-center gap-2"><h2 class="font-medium">Alerts</h2><form method="POST" action="?/check" use:enhance class="ml-auto"><button class="btn !h-8 text-xs">Check now</button></form></div>
		<div class="card p-3 text-sm">
			{#each data.urgent as a (a.id)}
				<div class="border-b py-2 last:border-b-0" style="border-color:var(--border)"><div class="text-[11px] text-muted-foreground">{ago(a.createdAt)} · {a.delivery === 'sent' ? 'sent' : a.delivery === 'failed' ? 'sending failed' : 'in-app only'}</div>
					{#each a.urgent?.items ?? [] as i}<div class="mt-0.5"><span class="pii text-xs text-muted-foreground">{i.site}</span> <a class="hover:underline" href={i.href}>{i.title}</a></div>{/each}</div>
			{:else}<p class="text-muted-foreground">No alerts so far. A blocking problem (tracking broken, key pages blocked or de-indexed, a collapse in traffic) is announced here the moment it is found.</p>{/each}
		</div>
	</section>
	<section>
		<h2 class="mb-1 font-medium">Earlier digests</h2>
		<div class="card p-3 text-sm">
			{#each data.history as h (h.id)}<div class="flex items-center gap-2 py-1"><a class="hover:underline" href="?id={h.id}">{h.weekKey ? 'Week of ' + h.weekKey : 'Made by hand, ' + ago(h.createdAt)}</a><span class="ml-auto text-xs text-muted-foreground">{h.delivery === 'sent' ? 'sent' : h.delivery === 'failed' ? 'send failed' : ''}</span></div>{:else}<p class="text-muted-foreground">None yet.</p>{/each}
		</div>
	</section>
</div>
