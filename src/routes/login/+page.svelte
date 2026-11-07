<script lang="ts">
	let { form } = $props();
</script>

<div class="mx-auto mt-24 max-w-sm">
	<img src="/brand/logo-light.svg" alt="" width="64" height="64" class="mb-4 size-16 rounded-2xl shadow-sm" />
	<h1 class="mb-1 text-xl font-semibold">SEOConsole</h1>
	<p class="mb-6 text-sm text-muted-foreground">Enter the admin password to continue.</p>
	<form method="POST" class="space-y-3">
		<input class="input w-full" type="password" name="password" placeholder="Password" autocomplete="current-password" required />
		{#if form?.error}<p class="text-sm text-bad">{form.error}</p>{/if}
		<button class="btn btn-primary w-full">Sign in</button>
	</form>
</div>
