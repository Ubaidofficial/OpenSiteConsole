<script lang="ts">
	/**
	 * Site logo over a letter avatar (hue derived from the name). The logo is /sites/[id]/icon, which the server fetches from the
	 * site itself, so no third-party favicon service learns which sites you watch. No logo (404, another host, a broken file) leaves
	 * the letter. Without a siteId it is only the letter.
	 */
	let { name, siteId = null, class: className = '' }: { name: string; siteId?: number | null; class?: string } = $props();
	const hue = $derived([...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7));
	const letter = $derived((name.replace(/^(www\.|https?:\/\/)/, '')[0] ?? '?').toUpperCase());
	let img = $state<HTMLImageElement>();
	let ok = $state(false);
	let dead = $state(false);

	// Listeners are added in the browser, not as onload/onerror attributes: those would be written into the server-rendered HTML,
	// which the Content-Security-Policy refuses to run.
	$effect(() => {
		const el = img;
		if (!el) return;
		const good = () => (ok = el.naturalWidth > 0);
		const bad = () => (dead = true);
		el.addEventListener('load', good);
		el.addEventListener('error', bad);
		if (el.complete) (el.naturalWidth > 0 ? good : bad)();
		return () => {
			el.removeEventListener('load', good);
			el.removeEventListener('error', bad);
		};
	});
</script>

<span class="avatar relative grid size-10 shrink-0 place-items-center overflow-hidden rounded-xl text-base font-semibold {className}" style="--h:{hue}" aria-hidden="true">
	{letter}
	{#if siteId != null && !dead}
		<img bind:this={img} src="/sites/{siteId}/icon" alt="" decoding="async" class="absolute inset-0 size-full bg-card object-contain p-1.5 transition-opacity {ok ? 'opacity-100' : 'opacity-0'}" />
	{/if}
</span>
