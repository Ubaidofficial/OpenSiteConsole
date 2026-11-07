<script lang="ts">
	let { data } = $props();
</script>

<article class="mx-auto max-w-4xl">
	<h1 class="mb-1 text-xl font-semibold">SEOConsole compared</h1>
	<p class="mb-4 max-w-3xl text-sm text-muted-foreground">
		SEOConsole is a Search Console dashboard with SEO tests, indexing tools and an MCP server. It is <b class="text-foreground">free to self-host</b> (<a class="underline" href={data.repo}>source and install guide</a>), and {data.hosted}
		These pages compare it with the tools people weigh it against. They are meant to be fair: what each competitor offers comes from its own public pages (read on {data.checkedOn}), what it does not say is marked “not stated”, and the rows where it is ahead stay in.
	</p>
	<div class="space-y-4">
		{#each data.tools as t}
			<section class="card p-4">
				<div class="flex flex-wrap items-center gap-2"><h2 class="font-medium"><a class="hover:underline" href="/compare/{t.slug}">SEOConsole vs {t.name}</a></h2></div>
				<p class="mt-1 text-sm text-muted-foreground">{t.blurb}</p>
				<div class="mt-3 grid grid-cols-1 gap-3 md:grid-cols-[1fr_16rem]">
					<dl class="space-y-1.5 text-sm">
						<div><dt class="inline font-medium">Their price: </dt><dd class="inline text-muted-foreground">{t.price}</dd></div>
						<div><dt class="inline font-medium text-good">Where SEOConsole is ahead: </dt><dd class="inline text-muted-foreground">{t.weWin}</dd></div>
						<div><dt class="inline font-medium text-warn">Where {t.name} is ahead: </dt><dd class="inline text-muted-foreground">{t.theyWin}</dd></div>
						<div class="pt-1"><a class="btn !h-8 text-xs" href="/compare/{t.slug}">Full comparison →</a></div>
					</dl>
					<a href="/compare/{t.slug}" class="block"><img class="w-full rounded border" src={t.shot.src} alt={t.shot.alt} loading="lazy" /></a>
				</div>
			</section>
		{/each}
	</div>
</article>
