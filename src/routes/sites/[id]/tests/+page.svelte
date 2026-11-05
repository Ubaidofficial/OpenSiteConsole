<script lang="ts">
	import { enhance } from '$app/forms';
	import { ConfirmButton } from '$lib/components/ui/confirm';
	import LineChart from '$lib/components/LineChart.svelte';
	import { fmtInt, fmtPos } from '$lib/format';
	let { data, form } = $props();
	let kind = $state<'before_after' | 'split' | 'switch'>('before_after');
	const kinds = { before_after: 'Before / after', split: 'Split (control pages)', switch: 'Redirect / URL switch' } as const;
	const pct = (v: number | null) => (v == null ? '–' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`);
	const verdictText: Record<string, [string, string]> = {
		positive: ['Likely a real gain', 'text-good'],
		negative: ['Likely a real loss', 'text-bad'],
		inconclusive: ['No clear effect', 'text-muted-foreground'],
		'too-little-data': ['Not enough data yet', 'text-warn']
	};
</script>

<p class="mb-3 max-w-3xl text-sm text-muted-foreground">
	Did a change move the pages it touched? Each test compares the <b>test pages</b> before and after the change date against <b>control pages</b> over the same days, so a site-wide rise, a season or a Google update does not get credited to your change.
	It is observational, not randomised: a significant result means “unlikely to be noise given the control”, not proof that the change caused it.
</p>

<section class="card mb-5 p-4">
	<h2 class="mb-2 font-medium">New test</h2>
	<form method="POST" action="?/create" use:enhance class="grid grid-cols-1 gap-3 text-sm md:grid-cols-2">
		<input class="input" name="name" placeholder="Name, e.g. New titles on /guides/" required />
		<select class="input" name="kind" bind:value={kind}>{#each Object.entries(kinds) as [k, l]}<option value={k}>{l}</option>{/each}</select>
		<label class="flex items-center gap-2"><span class="w-40 text-xs text-muted-foreground">Change went live on</span><input class="input" type="date" name="startDate" max={data.today} required /></label>
		<label class="flex items-center gap-2"><span class="w-40 text-xs text-muted-foreground">Compare windows of</span><select class="input" name="windowDays"><option value="14">14 days</option><option value="28" selected>28 days</option><option value="56">56 days</option></select></label>
		{#if kind !== 'switch'}
			<label class="md:col-span-2"><span class="mb-1 block text-xs text-muted-foreground">Test pages: a path such as <code>/guides/</code>, or full URLs, one per line</span><textarea class="input h-20 w-full" name="treatment" required></textarea></label>
		{:else}
			<label><span class="mb-1 block text-xs text-muted-foreground">Old URLs (path prefix or URLs)</span><textarea class="input h-20 w-full" name="old" required></textarea></label>
			<label><span class="mb-1 block text-xs text-muted-foreground">New URLs (path prefix or URLs)</span><textarea class="input h-20 w-full" name="new" required></textarea></label>
			<p class="text-xs text-muted-foreground md:col-span-2">Old and new are measured together, so traffic that simply moved from one to the other is not counted as a loss. The result shows whether the move kept the traffic.</p>
		{/if}
		{#if kind === 'split'}
			<div class="md:col-span-2">
				<label class="flex items-center gap-2 text-xs"><input type="checkbox" name="autoControl" checked /> Pick control pages automatically: pages outside the test group with similar traffic before the change (recommended)</label>
				<textarea class="input mt-2 h-16 w-full" name="control" placeholder="…or name the control pages yourself. Leave both empty to use the rest of the site."></textarea>
			</div>
		{:else}
			<p class="text-xs text-muted-foreground md:col-span-2">Control = every other page on the site.</p>
		{/if}
		<input class="input md:col-span-2" name="note" placeholder="Note (optional): what exactly changed" />
		<div class="md:col-span-2"><button class="btn btn-primary">Save test</button>
			{#if form?.ok}<span class="ml-3 text-sm text-good">{form.ok}</span>{/if}{#if form?.error}<span class="ml-3 text-sm text-bad">{form.error}</span>{/if}</div>
	</form>
</section>

{#each data.tests as t (t.id)}
	{@const o = t.outcome}
	{@const v = verdictText[o.clicks.verdict]}
	<article class="card mb-4 p-4">
		<div class="mb-2 flex flex-wrap items-center gap-2">
			<h3 class="font-medium">{t.name}</h3><span class="chip">{kinds[t.kind]}</span>
			<span class="text-xs text-muted-foreground">change on {t.startDate} · {o.postDays} day{o.postDays === 1 ? '' : 's'} of data after it · {o.treatmentPages} test pages vs {o.controlPages} control pages{t.restControl ? ' (rest of site)' : ''}</span>
			<form method="POST" action="?/remove" use:enhance class="ml-auto"><input type="hidden" name="id" value={t.id} /><ConfirmButton title="Delete this test?" description="Only the test definition is removed; your Search Console data is untouched." confirmLabel="Delete test">Delete</ConfirmButton></form>
		</div>
		{#if t.note}<p class="mb-2 text-xs text-muted-foreground">{t.note}</p>{/if}
		<div class="mb-3 grid grid-cols-1 gap-3 md:grid-cols-3">
			<div class="rounded-lg border p-3"><div class="text-xs text-muted-foreground">Clicks, test vs control</div><div class="tnum text-xl font-semibold {v[1]}">{pct(o.clicks.lift)}</div>
				<div class="text-xs {v[1]}">{v[0]}</div>
				{#if o.clicks.ciLow != null}<div class="text-[11px] text-muted-foreground">95% range {pct(o.clicks.ciLow)} to {pct(o.clicks.ciHigh)} · p = {o.clicks.p!.toFixed(3)}</div>{/if}</div>
			<div class="rounded-lg border p-3"><div class="text-xs text-muted-foreground">Impressions, test vs control</div><div class="tnum text-xl font-semibold">{pct(o.impressions.lift)}</div>
				<div class="text-xs {verdictText[o.impressions.verdict][1]}">{verdictText[o.impressions.verdict][0]}</div></div>
			<div class="rounded-lg border p-3"><div class="text-xs text-muted-foreground">Average position of test pages</div>
				<div class="tnum text-xl font-semibold">{o.position ? `${fmtPos(o.position.before)} → ${fmtPos(o.position.after)}` : '–'}</div><div class="text-[11px] text-muted-foreground">lower is better; descriptive, not tested</div></div>
		</div>
		{#if o.clicks.note}<p class="mb-2 text-xs text-warn">{o.clicks.note}</p>{/if}
		<div class="mb-2 text-xs text-muted-foreground">Clicks: test {fmtInt(o.clicks.totals.tPre)} → {fmtInt(o.clicks.totals.tPost)} · control {fmtInt(o.clicks.totals.cPre)} → {fmtInt(o.clicks.totals.cPost)} (before → after)
			{#if o.parts} · old URLs {fmtInt(o.parts.oldPre)} → {fmtInt(o.parts.oldPost)}, new URLs {fmtInt(o.parts.newPre)} → {fmtInt(o.parts.newPost)}{/if}</div>
		<LineChart xs={o.series.map((s) => s.date)} baseline={100} zero={false} marker={{ x: o.startDate, label: 'change' }} height={200} format={(n) => String(Math.round(n))}
			series={[{ label: 'Test pages (clicks, 100 = average before)', color: 'var(--c-clicks)', values: o.series.map((s) => s.treatment) }, { label: 'Control pages', color: 'var(--muted-foreground)', values: o.series.map((s) => s.control) }]} />
	</article>
{:else}
	<div class="card p-6 text-center text-sm text-muted-foreground">No tests yet. Save one above after you change a group of pages, then come back once a couple of weeks have passed.</div>
{/each}
