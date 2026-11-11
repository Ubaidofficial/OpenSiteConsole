<script lang="ts">
	let { data, form } = $props();
</script>

<div class="mx-auto mt-24 max-w-sm">
	<img src="/brand/logo-light.svg" alt="" width="64" height="64" class="mb-4 size-16 rounded-2xl shadow-sm" />
	<h1 class="mb-1 text-xl font-semibold">SEOConsole</h1>
	<p class="mb-6 text-sm text-muted-foreground">Sign in with your email and password. The owner can leave the email empty and use the admin password.</p>
	<form method="POST" class="space-y-3">
		<label class="block text-sm">
			<span class="mb-1 block text-xs text-muted-foreground">Email (team members)</span>
			<input class="input w-full" type="email" name="email" placeholder="you@example.com" autocomplete="username" value={form && 'email' in form ? form.email : ''} />
		</label>
		<label class="block text-sm">
			<span class="mb-1 block text-xs text-muted-foreground">Password</span>
			<input class="input w-full" type="password" name="password" placeholder="Password" autocomplete="current-password" required />
		</label>
		{#if form?.error}<p class="text-sm text-bad" role="alert">{form.error}</p>{/if}
		<button class="btn btn-primary w-full">Sign in</button>
	</form>
	{#if data.googleError}<p class="mt-3 text-sm text-bad" role="alert">{data.googleError}</p>{/if}
	{#if data.googleLogin}
		<div class="my-4 flex items-center gap-3 text-xs text-muted-foreground"><span class="h-px flex-1 bg-border"></span>or<span class="h-px flex-1 bg-border"></span></div>
		<a class="btn w-full" href="/login/google{data.next ? `?next=${encodeURIComponent(data.next)}` : ''}">Continue with Google</a>
		<p class="mt-2 text-xs text-muted-foreground">Only people already on the team (or the owner’s address) can sign in this way.</p>
	{/if}
	<p class="mt-4 text-xs text-muted-foreground">Forgot your password? SEOConsole cannot email a reset link: ask an admin for one{data.googleLogin ? ', or sign in with Google' : ''}. The owner password is <code>ADMIN_PASSWORD</code> in the server’s environment.</p>
</div>
