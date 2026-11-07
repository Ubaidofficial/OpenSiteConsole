<script lang="ts">
	import type { LegalSection } from '$lib/legal';
	let { title, sections, authed, configured, other }: { title: string; sections: LegalSection[]; authed: boolean; configured: boolean; other: { href: string; label: string } } = $props();
</script>

<article class="mx-auto max-w-3xl">
	<h1 class="mb-1 text-xl font-semibold">{title}</h1>
	{#if authed && !configured}
		<p class="mb-4 rounded border p-3 text-sm text-warn" style="border-color:var(--border)">
			You are seeing this note because you are signed in: nobody else sees it. This page names no operator or contact yet. Set <code>LEGAL_ENTITY</code> and <code>LEGAL_CONTACT_EMAIL</code> (and <code>LEGAL_GOVERNING_LAW</code> for the terms) and restart.
			The text is a starting point, not legal advice: have it reviewed before you rely on it, for example for Google's OAuth verification.
		</p>
	{/if}
	{#each sections as s}
		<section class="mt-5">
			<h2 class="mb-1 font-medium">{s.title}</h2>
			{#each s.paras as p}<p class="mb-2 text-sm leading-relaxed text-muted-foreground">{p}</p>{/each}
			{#if s.items?.length}<ul class="mb-2 list-disc space-y-1 pl-5 text-sm leading-relaxed text-muted-foreground">{#each s.items as it}<li>{it}</li>{/each}</ul>{/if}
		</section>
	{/each}
	<p class="mt-8 text-sm"><a class="underline" href={other.href}>{other.label}</a></p>
</article>
