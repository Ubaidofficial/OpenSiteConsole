<script lang="ts">
	/**
	 * "Is Clarity recording?" — three checks in a row (script on the pages, token connected, data arriving), the pages that were
	 * looked at, and, when the script is missing, two ways to add it: one click through Tag Manager (shown first, changed only after
	 * a preview and a confirming click) or the code for the site's <head>.
	 */
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { ago } from '$lib/format';
	import { claritySnippet } from '$lib/clarityinstall';
	import type { ClarityInstall, ScannedPage } from '$lib/clarityinstall';
	import { untrack } from 'svelte';
	import { Check, X, Minus, LoaderCircle } from '@lucide/svelte';

	type Plan = { ok: boolean; error?: string; needsGrant?: boolean; projectId?: string; container?: { publicId: string; name: string }; existing?: { name: string; clarityId: string | null; firing: string[]; paused: boolean }[]; canPublish?: boolean; publishBlocked?: string; tagName?: string; snippet?: string };
	type Result = { ok: boolean; error?: string; published: boolean; reviewUrl?: string; versionId?: string };
	let {
		install,
		scan,
		gtm,
		readOnly,
		connected,
		sessions,
		form
	}: {
		install: ClarityInstall;
		scan: { checkedAt: number; pages: ScannedPage[] } | null;
		gtm: { label: string; canWrite: boolean; account: string | null } | null;
		readOnly: boolean;
		connected: boolean;
		sessions: number | null;
		form: { plan?: Plan; result?: Result; project?: string; checked?: boolean } | null;
	} = $props();

	let busy = $state<string | null>(null);
	// the field starts with what was last submitted, then belongs to the user
	let project = $state(untrack(() => form?.project ?? ''));
	let copied = $state(false);
	const installed = $derived(install.state === 'on-page' || install.state === 'via-gtm' || install.state === 'unseen');
	const plan = $derived(form?.plan);
	const result = $derived(form?.result);
	const pathOf = (u: string) => {
		try {
			return new URL(u).pathname;
		} catch {
			return u;
		}
	};
	const typedId = $derived(/^[a-z0-9]{6,16}$/i.test(project.trim()) ? project.trim().toLowerCase() : (plan?.projectId ?? install.ids[0] ?? null));
	const back = $derived(`/sites/${page.params.id}/clarity`);

	const STATE: Record<ClarityInstall['state'], { tone: 'good' | 'warn' | 'bad' | 'muted'; text: string }> = {
		'on-page': { tone: 'good', text: 'Installed on your pages' },
		'via-gtm': { tone: 'good', text: 'Installed through Tag Manager' },
		unseen: { tone: 'good', text: 'Recording (the script is added by JavaScript)' },
		'gtm-not-firing': { tone: 'warn', text: 'In Tag Manager, but it never runs' },
		missing: { tone: 'bad', text: 'Not installed: Clarity records nothing' },
		unknown: { tone: 'muted', text: 'Not checked yet' }
	};
	const st = $derived(install.state === 'unknown' && install.pagesChecked ? { tone: 'muted' as const, text: 'Could not read the pages' } : STATE[install.state]);
	const steps = $derived([
		{ label: 'Script on the pages', ok: installed ? true : install.state === 'unknown' ? null : false, note: install.state === 'unseen' ? 'not in the HTML, but recording' : installed ? (install.ids.length ? `project ${install.ids.join(', ')}` : 'project ID not readable') : install.state === 'gtm-not-firing' ? 'tag never fires' : install.state === 'unknown' ? 'not checked' : 'not found' },
		{ label: 'API token connected', ok: connected, note: connected ? 'SEOConsole reads the data' : 'paste it on Connect' },
		// 0 sessions is only a problem while the script is missing; once installed, the first visits show up in the next daily snapshot
		{ label: 'Data arriving', ok: sessions == null ? null : sessions > 0 ? true : installed ? null : false, note: sessions == null ? 'no snapshot yet' : sessions === 0 && installed ? '0 so far: new visits appear in the next daily snapshot' : `${sessions.toLocaleString('en-US')} sessions in the latest snapshot` }
	]);
	const tone = (t: string) => (t === 'good' ? 'var(--good)' : t === 'warn' ? 'var(--warn)' : t === 'bad' ? 'var(--bad)' : 'var(--muted-foreground)');
	async function copy(text: string) {
		try {
			await navigator.clipboard.writeText(text);
			copied = true;
			setTimeout(() => (copied = false), 1500);
		} catch {
			/* the code stays on screen */
		}
	}
	const done = (name: string) => () => {
		busy = name;
		return async ({ update }: { update: (o?: { reset?: boolean }) => Promise<void> }) => {
			await update({ reset: false });
			busy = null;
		};
	};
</script>

<section class="card mb-4 p-4" aria-labelledby="clarity-install-h">
	<div class="flex flex-wrap items-start justify-between gap-3">
		<div>
			<h2 id="clarity-install-h" class="font-medium">Is Clarity recording?</h2>
			<p class="mt-1 inline-flex items-center gap-2 text-sm font-medium" style="color:{tone(st.tone)}"><span class="size-2 rounded-full" style="background:{tone(st.tone)}"></span>{st.text}{#if install.state === 'via-gtm' && gtm}<span class="font-normal text-muted-foreground">({gtm.label})</span>{/if}</p>
		</div>
		<form method="POST" action="?/check" use:enhance={done('check')} class="text-right">
			<button class="btn text-xs" disabled={busy === 'check'}>{#if busy === 'check'}<LoaderCircle class="size-3.5 animate-spin" />Checking…{:else}Check again{/if}</button>
			<p class="mt-1 text-[11px] text-muted-foreground">{scan ? `checked ${ago(scan.checkedAt)}` : 'never checked'}</p>
		</form>
	</div>

	<ol class="mt-4 grid gap-2 sm:grid-cols-3">
		{#each steps as s, i}
			<li class="flex items-start gap-2 rounded-lg border px-3 py-2">
				<span class="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full text-white" style="background:{s.ok === true ? 'var(--good)' : s.ok === false ? 'var(--bad)' : 'var(--muted-foreground)'}">
					{#if s.ok === true}<Check class="size-3.5" />{:else if s.ok === false}<X class="size-3.5" />{:else}<Minus class="size-3.5" />{/if}
				</span>
				<span class="min-w-0 text-sm"><span class="text-xs text-muted-foreground">{i + 1}.</span> {s.label}<span class="block truncate text-xs text-muted-foreground">{s.note}</span></span>
			</li>
		{/each}
	</ol>

	{#if scan?.pages.length}
		<details class="mt-3 text-xs">
			<summary class="cursor-pointer text-muted-foreground">Pages checked ({install.pagesOk} of {install.pagesChecked} read)</summary>
			<ul class="mt-2 space-y-1">
				{#each scan.pages as p}
					<li class="flex flex-wrap items-center gap-x-2">
						<span class="pii font-mono">{pathOf(p.url)}</span>
						{#if !p.ok}<span class="text-warn">{p.error}</span>
						{:else}<span style="color:{p.clarityLoader ? 'var(--good)' : 'var(--muted-foreground)'}">{p.clarityLoader ? `Clarity ${p.clarityIds.join(', ')}` : 'no Clarity'}</span>{#if p.gtmIds.length}<span class="text-muted-foreground">· loads {p.gtmIds.join(', ')}</span>{/if}{/if}
					</li>
				{/each}
			</ul>
			<p class="mt-2 text-muted-foreground">Checked daily from the page HTML. A script that the page's own JavaScript adds later is not visible to this check.</p>
		</details>
	{/if}

	{#each install.findings.filter((f) => f.severity !== 'info' || f.id === 'clarity-container-not-seen' || f.id === 'clarity-check-failed' || f.id === 'clarity-script-unseen') as f}
		<div class="mt-3 rounded-lg border-l-4 bg-muted/40 px-3 py-2 text-sm" style="border-color:{f.severity === 'warning' ? 'var(--warn)' : 'var(--border)'}"><b>{f.title}.</b> <span class="text-muted-foreground">{f.detail}</span></div>
	{/each}

	{#if result}
		<div class="mt-3 rounded-lg border px-3 py-2" role="status">
		{#if result.ok}
			<p class="text-xs" style="color:var(--good)"><b>{result.published ? `Published${result.versionId ? ` as version ${result.versionId}` : ''}.` : 'The tag is ready in a new workspace.'}</b> <span class="text-muted-foreground">{result.published ? 'Clarity starts recording on the next visits; the check above updates within a few minutes.' : 'Open it in Tag Manager, check it and press Submit to publish.'}</span></p>
		{:else}
			<p class="text-xs text-bad">{result.error}</p>
		{/if}
		{#if result.reviewUrl}<a class="mt-1 inline-block text-xs underline" href={result.reviewUrl} target="_blank" rel="noreferrer noopener">Open in Tag Manager</a>{/if}
		</div>
	{/if}

	{#if !installed}
		<div class="mt-5 border-t pt-4">
			<h3 class="mb-1 text-sm font-medium">Add Clarity to {page.data.site?.name ?? 'the site'}</h3>
			<p class="mb-3 text-xs text-muted-foreground">You need the Clarity project for this site: in Clarity, open the project, then <b>Settings → Setup</b>. Paste its project ID or the whole tracking code.</p>
			<label class="mb-3 block text-xs"><span class="text-muted-foreground">Clarity project ID or tracking code</span>
				<textarea class="input mt-1 h-auto w-full font-mono text-xs" rows="2" bind:value={project} placeholder="abc123xyz9, or paste the <script> from Clarity"></textarea>
			</label>

			<div class="grid gap-3 lg:grid-cols-2">
				<!-- 1. Tag Manager: preview, then confirm -->
				<div class="rounded-lg border p-3">
					<p class="text-sm font-medium">One click, through Tag Manager</p>
					{#if !gtm}
						<p class="mt-1 text-xs text-muted-foreground">Link this site's Tag Manager container on the <a class="underline" href="/connect">Connect page</a> and SEOConsole can add the tag for you.</p>
					{:else if readOnly}
						<p class="mt-1 text-xs text-warn">This server runs with READ_ONLY=1, so it never changes Tag Manager.</p>
					{:else if !gtm.canWrite}
						<p class="mt-1 mb-2 text-xs text-muted-foreground">SEOConsole can read <b>{gtm.label}</b> but not edit it. Allow it once{gtm.account ? ` with ${gtm.account}` : ''}: Google will ask to let SEOConsole edit, version and publish your Tag Manager containers. It only ever adds the Clarity tag, after showing you the change.</p>
						<a class="btn btn-primary text-xs" href="/auth/connect?grant=gtm-write&back={encodeURIComponent(back)}">Allow SEOConsole to edit Tag Manager</a>
					{:else}
						<p class="mt-1 mb-2 text-xs text-muted-foreground">Adds a Custom HTML tag with Clarity's code to <b>{gtm.label}</b>, firing on All Pages, in a new workspace. Nothing changes until you confirm.</p>
						<form method="POST" action="?/plan" use:enhance={done('plan')}>
							<input type="hidden" name="project" value={project} />
							<button class="btn text-xs" disabled={!project.trim() || busy === 'plan'}>{busy === 'plan' ? 'Preparing…' : 'Preview the change'}</button>
						</form>
					{/if}

					{#if plan && !result}
						{#if !plan.ok}
							<p class="mt-2 text-xs text-bad">{plan.error}</p>
							{#if plan.needsGrant}<a class="btn mt-2 text-xs" href="/auth/connect?grant=gtm-write&back={encodeURIComponent(back)}">Allow SEOConsole to edit Tag Manager</a>{/if}
						{:else}
							<div class="mt-3 rounded-md border bg-muted/40 p-3 text-xs" role="region" aria-label="Preview of the Tag Manager change">
								<p class="mb-2 font-medium text-foreground">This will be added</p>
								<dl class="grid grid-cols-[7rem_1fr] gap-y-1">
									<dt class="text-muted-foreground">Container</dt><dd>{plan.container?.publicId}{plan.container?.name ? ` · ${plan.container.name}` : ''}</dd>
									<dt class="text-muted-foreground">Workspace</dt><dd>a new one, “SEOConsole: Microsoft Clarity”</dd>
									<dt class="text-muted-foreground">Tag</dt><dd>{plan.tagName} (Custom HTML)</dd>
									<dt class="text-muted-foreground">Fires on</dt><dd>All Pages</dd>
									<dt class="text-muted-foreground">Clarity project</dt><dd class="font-mono">{plan.projectId}</dd>
								</dl>
								<details class="mt-2"><summary class="cursor-pointer text-muted-foreground">The tag's code</summary><!-- svelte-ignore a11y_no_noninteractive_tabindex: a scrollable code block must be reachable by keyboard --><pre tabindex="0" class="mt-1 overflow-x-auto rounded bg-background p-2 text-[11px]">{plan.snippet}</pre></details>
								{#if plan.existing?.length}<p class="mt-2 text-warn">The live container already has {plan.existing.map((t) => `“${t.name}”${t.clarityId ? ` (${t.clarityId})` : ''}`).join(', ')}. Adding another loads Clarity twice; fix or remove the old one in Tag Manager instead if it is the same project.</p>{/if}
								<form method="POST" action="?/install" use:enhance={done('install')} class="mt-3 flex flex-wrap gap-2">
									<input type="hidden" name="project" value={plan.projectId} />
									<button class="btn btn-primary text-xs" name="mode" value="publish" disabled={!plan.canPublish || !!busy}>{busy === 'install' ? 'Working…' : 'Add and publish'}</button>
									<button class="btn text-xs" name="mode" value="workspace" disabled={!!busy}>Add, I'll publish in Tag Manager</button>
								</form>
								{#if !plan.canPublish && plan.publishBlocked}<p class="mt-2 text-muted-foreground">{plan.publishBlocked}</p>{/if}
							</div>
						{/if}
					{/if}

				</div>

				<!-- 2. By hand -->
				<div class="rounded-lg border p-3">
					<p class="text-sm font-medium">Or add the code to your site</p>
					<p class="mt-1 mb-2 text-xs text-muted-foreground">Paste it inside <code>&lt;head&gt;</code> on every page (your theme or layout file).</p>
					{#if typedId}
						{@const code = claritySnippet(typedId)}
						<!-- svelte-ignore a11y_no_noninteractive_tabindex: a scrollable code block must be reachable by keyboard -->
						<pre tabindex="0" class="max-h-40 overflow-auto rounded-md border bg-muted p-2 text-[11px]">{code}</pre>
						<button type="button" class="btn mt-2 text-xs" onclick={() => copy(code)}>{copied ? 'Copied' : 'Copy code'}</button>
						<details class="mt-2 text-xs"><summary class="cursor-pointer text-muted-foreground">Next.js</summary>
							<p class="mt-1 text-muted-foreground">In <code>app/layout.tsx</code>, import <code>Script</code> from <code>next/script</code> and put the snippet's inner code in <code>&lt;Script id="clarity" strategy="afterInteractive"&gt;</code> inside <code>&lt;body&gt;</code>.</p>
						</details>
					{:else}
						<p class="text-xs text-muted-foreground">Enter the project ID above to get the code here, or copy it from Clarity's setup page.</p>
					{/if}
				</div>
			</div>
		</div>
	{/if}
</section>
