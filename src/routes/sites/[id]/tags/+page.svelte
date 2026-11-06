<script lang="ts">
	import { ago } from '$lib/format';
	let { data } = $props();
	const tone = { critical: 'text-bad', warning: 'text-warn', info: 'text-muted-foreground' } as const;
	const icon = { critical: '✕', warning: '⚠', info: 'ℹ' } as const;
</script>

{#if !data.linked}
	<div class="card p-6 text-center"><p class="mb-3">No Tag Manager container is linked to this site yet.</p><a class="btn btn-primary" href="/connect">Connect Tag Manager</a></div>
	{#if data.findings.length}<p class="mt-3 text-xs text-muted-foreground">GA4 versus Search Console can still be checked:</p>{/if}
{:else}
	<p class="mb-2 text-xs text-muted-foreground">Container: <b class="pii">{data.container}</b> · {data.status?.state === 'error' ? data.status.message : 'synced ' + ago(data.status?.lastSync ?? null)}
		{#if data.snapshot} · {data.snapshot.published ? `live version ${data.snapshot.versionName || data.snapshot.versionId}` : 'never published'}{/if}</p>
{/if}

<section class="card mb-4 p-4">
	<h2 class="mb-1 font-medium">Tracking health <span class="text-xs font-normal text-muted-foreground">· Search Console + GA4{data.sources.gtm ? ' + Tag Manager' : ''}, last {data.window.days} days</span></h2>
	<p class="mb-3 text-xs text-muted-foreground">
		Search Console clicks: <b>{data.window.clicks.toLocaleString('en-US')}</b>
		· GA4 organic sessions: <b>{data.window.ga4 == null ? 'not available' : data.window.ga4.toLocaleString('en-US')}</b>.
		These are prompts to look, not proof of a problem.
	</p>
	{#if data.findings.length}
		<ul class="space-y-2 text-sm">
			{#each data.findings as f (f.id)}
				<li class="flex gap-2"><span class={tone[f.severity]} aria-label={f.severity}>{icon[f.severity]}</span><div><div class="font-medium">{f.title}</div><div class="text-xs text-muted-foreground">{f.detail}</div></div></li>
			{/each}
		</ul>
	{:else}
		<p class="text-sm text-good">{data.sources.gtm || data.sources.ga4 ? 'No problems found.' : 'Nothing to check yet: link GA4 and a Tag Manager container on the Connect page.'}</p>
	{/if}
</section>

{#if data.snapshot}
	<section class="card overflow-x-auto">
		<div class="px-3 pt-3 text-xs text-muted-foreground">{data.snapshot.counts.tags} tags · {data.snapshot.counts.triggers} triggers · {data.snapshot.counts.variables} variables (live version)</div>
		<table class="w-full">
			<thead><tr><th class="th">Tag</th><th class="th">Type</th><th class="th">Fires on</th><th class="th">GA4 ID / event</th><th class="th">State</th></tr></thead>
			<tbody>
				{#each data.snapshot.tags as t (t.id || t.name)}
					<tr>
						<td class="td">{t.name}</td>
						<td class="td text-xs">{t.typeLabel}</td>
						<td class="td text-xs">{t.firing.length ? t.firing.join(', ') : '–'}{#if t.blocking.length}<div class="text-muted-foreground">blocked by {t.blocking.join(', ')}</div>{/if}</td>
						<td class="td text-xs">{t.measurementId ?? ''}{t.eventName ? ' · ' + t.eventName : ''}</td>
						<td class="td text-xs {t.paused ? 'text-warn' : 'text-good'}">{t.paused ? 'paused' : 'active'}</td>
					</tr>
				{:else}<tr><td class="td text-muted-foreground" colspan="5">{data.snapshot.published ? 'The live version has no tags.' : 'Nothing is published, so nothing runs.'}</td></tr>{/each}
			</tbody>
		</table>
	</section>
{/if}
