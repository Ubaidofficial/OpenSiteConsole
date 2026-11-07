<script lang="ts">
	import LegalPage from '$lib/components/LegalPage.svelte';
	let { data } = $props();
</script>

<LegalPage title="Privacy policy" sections={data.sections} authed={data.authed} configured={data.configured} other={{ href: '/terms', label: 'Terms of service' }} />
