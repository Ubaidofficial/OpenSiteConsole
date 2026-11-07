<script lang="ts">
	import LegalPage from '$lib/components/LegalPage.svelte';
	let { data } = $props();
</script>

<LegalPage title="Terms of service" sections={data.sections} authed={data.authed} configured={data.configured} other={{ href: '/privacy', label: 'Privacy policy' }} />
