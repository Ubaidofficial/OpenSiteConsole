<script lang="ts">
	let { data, form } = $props();
</script>

<div class="mx-auto mt-16 max-w-sm">
	<img src="/brand/logo-light.svg" alt="" width="64" height="64" class="mb-4 size-16 rounded-2xl shadow-sm dark:hidden" />
	<img src="/brand/logo-dark.svg" alt="" width="64" height="64" class="mb-4 hidden size-16 rounded-2xl shadow-sm dark:block" />
	<h1 class="mb-1 text-xl font-semibold">Join SEOConsole</h1>
	{#if data.valid}
		<p class="mb-6 text-sm text-muted-foreground">You were invited as <b>{data.email}</b> with the <span class="chip">{data.role}</span> role. Choose your name and a password to finish.</p>
		{#if data.signedInAs}<p class="mb-4 text-xs text-warn">This browser is signed in as {data.signedInAs}; accepting signs that session out.</p>{/if}
		<form method="POST" class="space-y-3">
			<label class="block text-sm">
				<span class="mb-1 block text-xs text-muted-foreground">Email</span>
				<input class="input w-full" type="email" name="username" value={data.email} autocomplete="username" readonly />
			</label>
			<label class="block text-sm">
				<span class="mb-1 block text-xs text-muted-foreground">Your name</span>
				<input class="input w-full" name="name" maxlength="80" autocomplete="name" value={form && 'name' in form ? form.name : ''} required />
			</label>
			<label class="block text-sm">
				<span class="mb-1 block text-xs text-muted-foreground">Password (at least {data.minLength} characters)</span>
				<input class="input w-full" type="password" name="password" minlength={data.minLength} maxlength="256" autocomplete="new-password" required />
			</label>
			{#if form?.error}<p class="text-sm text-bad" role="alert">{form.error}</p>{/if}
			<button class="btn btn-primary w-full">Create account and sign in</button>
		</form>
		<p class="mt-4 text-xs text-muted-foreground">The link works once and expires {new Date(data.expiresAt).toLocaleDateString()}.</p>
	{:else}
		<p class="mb-6 text-sm text-muted-foreground" role="alert">{data.reason}</p>
		<a class="btn" href="/login">Go to sign-in</a>
	{/if}
</div>
