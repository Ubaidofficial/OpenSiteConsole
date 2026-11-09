<script lang="ts">
	import Explainer from '$lib/components/Explainer.svelte';
	import { enhance } from '$app/forms';
	import { ConfirmButton } from '$lib/components/ui/confirm';
	import LineChart from '$lib/components/LineChart.svelte';
	import { fmtInt, fmtPos } from '$lib/format';
	let { data, form } = $props();
	let kind = $state<'before_after' | 'split' | 'switch'>('before_after');
	let controlMode = $state<'matched' | 'rest' | 'named'>('matched');
	let metric = $state<'clicks' | 'ai_sessions'>('clicks');
	const kinds = { before_after: 'Before / after', split: 'Split (control pages)', switch: 'Redirect / URL switch' } as const;
	const pct = (v: number | null) => (v == null ? '–' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`);
	const verdictText: Record<string, [string, string]> = {
		positive: ['Likely a real gain', 'text-good'],
		negative: ['Likely a real loss', 'text-bad'],
		inconclusive: ['No clear effect', 'text-muted-foreground'],
		'too-little-data': ['Not enough data yet', 'text-warn'],
		'estimate-only': ['Estimate only: no verdict', 'text-warn']
	};
	const aiVerdictText: Record<string, [string, string]> = { ...verdictText, 'too-little-ai-traffic': ['Too little AI traffic to tell', 'text-warn'] };
	const perDay = (v: number) => (v >= 10 ? String(Math.round(v)) : v.toFixed(1));
</script>

<Explainer lead="Did a change move the pages it touched? Each test compares them with control pages over the same days.">
	<p>A test can be measured on search clicks, or on visits from AI assistants (an LLM test: ChatGPT, Perplexity, Gemini, Claude and Copilot sessions from GA4), for changes such as rewriting pages for AI answers or adding FAQs and schema. GA4 only sees assistants that send a referrer; visits from the rest land in Direct and are not counted.</p>
	<p>It is observational, not randomised: a significant result means “unlikely to be noise given the control”, not proof that the change caused it. Traffic drifts on its own, so the noise level is measured on this site's own earlier windows of the same length; that takes at least four windows of history before the change (112 days for 28-day windows, 56 for 14-day ones). With less, you get an estimate and no verdict. Real changes of around 40% are detectable on steady sites; on very drifty traffic only larger ones are.</p>
</Explainer>

<section class="card mb-5 p-4">
	<h2 class="mb-2 font-medium">New test</h2>
	<form method="POST" action="?/create" use:enhance class="grid grid-cols-1 gap-3 text-sm md:grid-cols-2">
		<input class="input" name="name" aria-label="Name" placeholder="Name, e.g. New titles on /guides/" required />
		<select class="input" name="kind" aria-label="Kind of test" bind:value={kind}>{#each Object.entries(kinds) as [k, l]}<option value={k}>{l}</option>{/each}</select>
		<label class="flex items-center gap-2"><span class="w-40 text-xs text-muted-foreground">Change went live on</span><input class="input" type="date" name="startDate" max={data.today} required /></label>
		<label class="flex items-center gap-2"><span class="w-40 text-xs text-muted-foreground">Measure on</span><select class="input" name="metric" bind:value={metric}><option value="clicks">Search clicks</option><option value="ai_sessions">AI-assistant sessions (LLM test)</option></select></label>
		{#if metric === 'ai_sessions'}
			<label class="flex items-center gap-2"><span class="w-40 text-xs text-muted-foreground">Assistant</span><select class="input" name="assistant"><option value="">All assistants</option>{#each data.assistants as a}<option value={a}>{a}</option>{/each}</select></label>
			<p class="text-xs text-muted-foreground md:col-span-2">{#if !data.ga4Linked}<span class="text-warn">Link a GA4 property on the Connect page first.</span> {/if}Measured on GA4 sessions from AI assistants. With little AI traffic the result says “too little AI traffic to tell”. Assistants that send no referrer land in Direct and are not counted.</p>
			{#if data.demoAi}<p class="text-xs text-muted-foreground md:col-span-2">Demo data: AI sessions to <code>{data.demoAi.liftPage}</code> rise from {data.demoAi.changeDate}; <code>{data.demoAi.flatPage}</code> did not change.</p>{/if}
		{/if}
		<label class="flex items-center gap-2"><span class="w-40 text-xs text-muted-foreground">Compare windows of</span><select class="input" name="windowDays"><option value="14">14 days</option><option value="28" selected>28 days</option><option value="56">56 days</option></select></label>
		{#if kind !== 'switch'}
			<label class="md:col-span-2"><span class="mb-1 block text-xs text-muted-foreground">Test pages: a path such as <code>/guides/</code> (matches every host of the property), a full URL ending in <code>/</code> (that page and everything below it), or exact URLs, one per line</span><textarea class="input h-20 w-full" name="treatment" required></textarea></label>
		{:else}
			<label><span class="mb-1 block text-xs text-muted-foreground">Old URLs (path prefix or URLs)</span><textarea class="input h-20 w-full" name="old" required></textarea></label>
			<label><span class="mb-1 block text-xs text-muted-foreground">New URLs (path prefix or URLs)</span><textarea class="input h-20 w-full" name="new" required></textarea></label>
			<p class="text-xs text-muted-foreground md:col-span-2">Old and new are measured together, so traffic that simply moved from one to the other is not counted as a loss. The result shows whether the move kept the traffic.</p>
		{/if}
		<fieldset class="md:col-span-2">
			<legend class="mb-1 text-xs text-muted-foreground">Control pages: what the test pages are compared against</legend>
			<label class="flex items-start gap-2 text-xs"><input type="radio" name="controlMode" value="matched" bind:group={controlMode} class="mt-0.5" /><span><b>Match automatically (recommended).</b> Pages in the sections of the site whose weekly clicks moved together with the test pages before the change. Picked from pre-change data only. On drifting traffic this detects real changes far more often than comparing with the whole site.</span></label>
			<label class="mt-1 flex items-start gap-2 text-xs"><input type="radio" name="controlMode" value="rest" bind:group={controlMode} class="mt-0.5" /><span>The rest of the site (every other page)</span></label>
			<label class="mt-1 flex items-start gap-2 text-xs"><input type="radio" name="controlMode" value="named" bind:group={controlMode} class="mt-0.5" /><span>I will name the control pages</span></label>
			{#if controlMode === 'named'}<textarea class="input mt-2 h-16 w-full" name="control" aria-label="A path such as /blog/ or full URLs" placeholder="A path such as /blog/ or full URLs, one per line"></textarea>{/if}
		</fieldset>
		<input class="input md:col-span-2" name="note" aria-label="Note" placeholder="Note (optional): what exactly changed" />
		<div class="md:col-span-2"><button class="btn btn-primary">Save test</button>
			{#if form?.ok}<span class="ml-3 text-sm text-good">{form.ok}</span>{/if}{#if form?.error}<span class="ml-3 text-sm text-bad">{form.error}</span>{/if}</div>
	</form>
</section>

{#each data.tests as t (t.id)}
	{#if !t.outcome}
		<article class="card mb-4 p-4"><div class="flex items-center gap-2"><h3 class="font-medium">{t.name}</h3><span class="text-xs text-bad">Could not be evaluated: {t.error}</span>
			<form method="POST" action="?/remove" use:enhance class="ml-auto"><input type="hidden" name="id" value={t.id} /><ConfirmButton title="Delete this test?" description="Only the test definition is removed; your Search Console data is untouched." confirmLabel="Delete test">Delete</ConfirmButton></form></div></article>
	{:else}
	{@const o = t.outcome}
	{@const v = verdictText[o.clicks.verdict]}
	{@const cv = o.conversions}
	{@const ai = t.metric === 'ai_sessions' ? o.ai : null}
	<article class="rise card mb-4 p-4">
		<div class="mb-2 flex flex-wrap items-center gap-2">
			<h3 class="font-medium">{t.name}</h3><span class="chip">{kinds[t.kind]}</span>{#if t.metric === 'ai_sessions'}<span class="chip">LLM test{t.assistant ? `: ${t.assistant}` : ''}</span>{/if}{#if t.fromChangeLog}<span class="chip">from change log</span>{/if}
			<span class="text-xs text-muted-foreground">change on {t.startDate} · {o.postDays} day{o.postDays === 1 ? '' : 's'} of data after it · {ai ? ai.treatmentPages : o.treatmentPages} test pages vs {ai ? ai.controlPages : o.controlPages} control pages{t.restControl || ai?.controlFallback ? ' (rest of site)' : t.controlMethod === 'sections' ? ' (matched sections)' : t.controlMethod === 'traffic' ? ' (matched on traffic)' : ''}</span>
			<form method="POST" action="?/remove" use:enhance class="ml-auto"><input type="hidden" name="id" value={t.id} /><ConfirmButton title="Delete this test?" description="Only the test definition is removed; your Search Console data is untouched." confirmLabel="Delete test">Delete</ConfirmButton></form>
		</div>
		{#if t.note}<p class="mb-2 text-xs text-muted-foreground">{t.note}</p>{/if}
		{#if !ai}
		<div class="mb-3 grid grid-cols-1 gap-3 md:grid-cols-3">
			<div class="rounded-lg border p-3"><div class="text-xs text-muted-foreground">Clicks, test vs control</div><div class="tnum text-xl font-semibold {v[1]}">{pct(o.clicks.lift)}</div>
				<div class="text-xs {v[1]}">{v[0]}</div>
				{#if o.clicks.ciLow != null}<div class="text-[11px] text-muted-foreground">95% range {pct(o.clicks.ciLow)} to {pct(o.clicks.ciHigh)} · p = {o.clicks.p!.toFixed(3)}</div>{/if}
				{#if o.clicks.calibration.placebos}<div class="text-[11px] text-muted-foreground">normal drift measured on {o.clicks.calibration.placebos} earlier windows{#if o.clicks.calibration.detectable != null} · smallest change this test could detect: about ±{(o.clicks.calibration.detectable * 100).toFixed(0)}%{/if}</div>{/if}
				{#if o.clicks.verdict === 'inconclusive' && o.clicks.calibration.detectable != null && o.clicks.calibration.detectable > 0.25}<div class="mt-1 text-[11px] text-warn">“No clear effect” is weak evidence here: a change smaller than {(o.clicks.calibration.detectable * 100).toFixed(0)}% would have looked the same. Let it run longer, widen the test pages, or test a bigger change.</div>{/if}</div>
			<div class="rounded-lg border p-3"><div class="text-xs text-muted-foreground">Impressions, test vs control</div><div class="tnum text-xl font-semibold">{pct(o.impressions.lift)}</div>
				<div class="text-xs {verdictText[o.impressions.verdict][1]}">{verdictText[o.impressions.verdict][0]}</div></div>
			<div class="rounded-lg border p-3"><div class="text-xs text-muted-foreground">Average position of test pages</div>
				<div class="tnum text-xl font-semibold">{o.position ? `${fmtPos(o.position.before)} → ${fmtPos(o.position.after)}` : '–'}</div><div class="text-[11px] text-muted-foreground">lower is better; descriptive, not tested</div></div>
		</div>
		{#if o.clicks.note}<p class="mb-2 text-xs text-warn">{o.clicks.note}</p>{/if}
		<div class="mb-3 rounded-lg border p-3">
			<div class="text-xs text-muted-foreground">Conversions (GA4 key events from Google organic), test vs control</div>
			{#if cv.status === 'ok' && cv.keyEvents && cv.sessions}
				{@const kv = verdictText[cv.keyEvents.verdict]}
				<div class="mt-1 flex flex-wrap items-baseline gap-x-5 gap-y-1">
					<div><span class="tnum text-xl font-semibold {kv[1]}">{pct(cv.keyEvents.lift)}</span> <span class="text-xs {kv[1]}">key events · {kv[0]}</span>{#if cv.keyEvents.ciLow != null}<div class="text-[11px] text-muted-foreground">95% range {pct(cv.keyEvents.ciLow)} to {pct(cv.keyEvents.ciHigh)}</div>{/if}</div>
					<div><span class="tnum text-base font-semibold">{pct(cv.sessions.lift)}</span> <span class="text-xs text-muted-foreground">organic sessions · {verdictText[cv.sessions.verdict][0].toLowerCase()}</span></div>
					{#if cv.rate && cv.rate.before != null && cv.rate.after != null}<div class="text-xs text-muted-foreground">key events per session on the test pages: {(cv.rate.before * 100).toFixed(2)}% → {(cv.rate.after * 100).toFixed(2)}% (not tested)</div>{/if}
				</div>
				{#if cv.keyEvents.note}<p class="mt-1 text-[11px] text-warn">{cv.keyEvents.note}</p>{/if}
				{#if o.clicks.verdict === 'positive' && cv.keyEvents.verdict === 'negative'}<p class="mt-2 rounded-md border border-[color:var(--bad)] p-2 text-xs text-bad">More clicks but fewer conversions. The change may be attracting the wrong audience (a broader or off-intent title or content). Do not roll it out on clicks alone.</p>{/if}
				{#if o.clicks.verdict === 'positive' && cv.keyEvents.verdict === 'inconclusive'}<p class="mt-2 text-[11px] text-muted-foreground">Clicks rose; key events show no clear change (they are rare, so this is often just too few to tell). Watch the key-event rate before rolling out.</p>{/if}
			{:else}
				<p class="mt-1 text-xs text-muted-foreground">{cv.note}</p>
			{/if}
		</div>
		{:else}
		{#if ai?.status === 'ok' && ai.sessions}
			{@const av = aiVerdictText[ai.verdict ?? 'too-little-data']}
			{@const sr = ai.sessions}
			<div class="mb-3 grid grid-cols-1 gap-3 md:grid-cols-3">
				<div class="rounded-lg border p-3 md:col-span-2"><div class="text-xs text-muted-foreground">AI-assistant sessions{ai.assistant ? ` from ${ai.assistant}` : ''}, test vs control</div>
					<div class="tnum text-xl font-semibold {ai.verdict === 'too-little-ai-traffic' ? 'text-muted-foreground' : av[1]}">{pct(sr.lift)}</div>
					<div class="text-xs {av[1]}">{av[0]}</div>
					{#if sr.ciLow != null}<div class="text-[11px] text-muted-foreground">95% range {pct(sr.ciLow)} to {pct(sr.ciHigh)} · p = {sr.p!.toFixed(3)}</div>{/if}
					{#if ai.detectable != null}<div class="text-[11px] text-muted-foreground">smallest change this test could detect: about ±{(ai.detectable * 100).toFixed(0)}%{ai.detectableBasis === 'counts' ? ' (from the session counts alone; normal drift adds to it)' : ` (normal drift measured on ${sr.calibration.placebos} earlier windows)`}</div>{/if}</div>
				<div class="rounded-lg border p-3"><div class="text-xs text-muted-foreground">Test pages by assistant, sessions a day (before → after)</div>
					{#each ai.assistants as a (a.assistant)}<div class="flex justify-between text-xs {ai.assistant && ai.assistant !== a.assistant ? 'text-muted-foreground' : ''}"><span>{a.assistant}</span><span class="tnum">{perDay(a.before)} → {perDay(a.after)}</span></div>{:else}<div class="text-xs text-muted-foreground">No AI-assistant sessions on the test pages.</div>{/each}</div>
			</div>
			{#if ai.note}<p class="mb-2 text-xs text-warn">{ai.note}</p>{/if}
			{#if ai.controlFallback}<p class="mb-2 text-xs text-muted-foreground">{ai.controlFallback}</p>{/if}
			<div class="mb-2 text-xs text-muted-foreground">AI sessions: test {fmtInt(sr.totals.tPre)} → {fmtInt(sr.totals.tPost)} · control {fmtInt(sr.totals.cPre)} → {fmtInt(sr.totals.cPost)} (before → after){#if o.clicks.lift != null} · search clicks on the same pages, for context: {pct(o.clicks.lift)} vs control ({verdictText[o.clicks.verdict][0].toLowerCase()}){/if}</div>
		{:else}
			<p class="mb-3 rounded-lg border p-3 text-xs text-muted-foreground">{ai?.note ?? 'No AI-assistant result yet.'}</p>
		{/if}
		{/if}
		{#each o.updates.filter((u) => u.window !== 'before' && (u.kind === 'core' || u.kind === 'spam')) as u}
			<p class="mb-2 rounded-md border border-[color:var(--warn)] p-2 text-xs text-warn">Google's <b>{u.name}</b> ({u.begin}{u.end ? ' to ' + u.end : ', still rolling out'}) overlaps this test's after-period. The control absorbs what hits the whole site, but an update can move one section and not another, so read this result with extra caution.</p>
		{/each}
		{#if t.controlNote}<p class="pii mb-2 text-xs text-muted-foreground">{t.controlNote}</p>{/if}
		{#if !ai}<div class="mb-2 text-xs text-muted-foreground">Clicks: test {fmtInt(o.clicks.totals.tPre)} → {fmtInt(o.clicks.totals.tPost)} · control {fmtInt(o.clicks.totals.cPre)} → {fmtInt(o.clicks.totals.cPost)} (before → after)
			{#if o.parts} · old URLs {fmtInt(o.parts.oldPre)} → {fmtInt(o.parts.oldPost)}, new URLs {fmtInt(o.parts.newPre)} → {fmtInt(o.parts.newPost)}{/if}</div>{/if}
		{#if ai?.status === 'ok'}
			<LineChart xs={ai.series.map((s) => s.date)} zero={true} markers={[{ x: o.startDate, label: 'change' }]} height={200} format={(n) => (n >= 10 ? String(Math.round(n)) : n.toFixed(1))}
				series={[{ label: 'Test pages (AI sessions a day, 7-day average)', color: 'var(--c-clicks)', values: ai.series.map((s) => s.treatment) }, { label: 'Control pages, scaled to the test pages before the change', color: 'var(--muted-foreground)', values: ai.series.map((s) => s.control) }]} />
			<p class="mt-1 text-[11px] text-muted-foreground">From GA4 referrers: assistants that send none land in Direct and are not counted here.</p>
		{:else if !ai}
		<LineChart xs={o.series.map((s) => s.date)} baseline={100} zero={false} markers={[{ x: o.startDate, label: 'change' }, ...o.updates.map((u) => ({ x: u.begin, label: u.name, color: 'var(--c-pos)' }))]} height={200} format={(n) => String(Math.round(n))}
			series={[{ label: 'Test pages (clicks, 100 = average before)', color: 'var(--c-clicks)', values: o.series.map((s) => s.treatment) }, { label: 'Control pages', color: 'var(--muted-foreground)', values: o.series.map((s) => s.control) }]} />
		{/if}
	</article>
	{/if}
{:else}
	<div class="card p-6 text-center text-sm text-muted-foreground">No tests yet. Save one above after you change a group of pages, then come back once a couple of weeks have passed.</div>
{/each}
