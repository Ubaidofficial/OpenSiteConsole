<script lang="ts">
	import { enhance } from '$app/forms';
	let { data, form } = $props();
	let busy = $state<string | null>(null);
	const submit = (name: string) => () => {
		busy = name;
		return async ({ update }: { update: (o?: { reset?: boolean }) => Promise<void> }) => {
			await update({ reset: form?.section === name ? false : true });
			busy = null;
		};
	};
	const msgFor = (s: string) => (form?.section === s ? form : null);
</script>

<h1 class="mb-1 text-lg font-semibold">Your account</h1>

{#if data.owner}
	<div class="card max-w-xl p-4 text-sm">
		<p>You are signed in as the <b>owner</b>. The owner is not a team member, so there is no email or name to change here.</p>
		<p class="mt-2 text-muted-foreground">The owner password is set with <code>ADMIN_PASSWORD</code> (or <code>ADMIN_PASSWORD_HASH</code>) in the server’s environment: change it there and restart. That signs every session out.</p>
		{#if data.googleLogin}
			<p class="mt-2 text-muted-foreground">{data.ownerEmails.length ? `You can sign in with Google as ${data.ownerEmails.join(', ')}.` : 'To let the owner sign in with Google, set OWNER_GOOGLE_EMAILS to your Google address.'}</p>
		{/if}
	</div>
{:else}
	<p class="mb-4 text-sm text-muted-foreground">Signed in as <span class="pii">{data.email}</span> <span class="chip">{data.roleLabel}</span></p>
	<div class="grid max-w-3xl gap-4 md:grid-cols-2">
		<section class="card p-4" aria-labelledby="p-name">
			<h2 id="p-name" class="mb-2 font-medium">Name</h2>
			<form method="POST" action="?/name" use:enhance={submit('name')} class="space-y-2">
				<label class="block text-sm"><span class="mb-1 block text-xs text-muted-foreground">Your name</span><input class="input w-full" name="name" maxlength="80" value={data.name} autocomplete="name" required /></label>
				{#if msgFor('name')?.ok}<p class="text-sm text-good" role="status">{msgFor('name')?.ok}</p>{/if}
				{#if msgFor('name')?.error}<p class="text-sm text-bad" role="alert">{msgFor('name')?.error}</p>{/if}
				<button class="btn" disabled={busy === 'name'}>Save name</button>
			</form>
		</section>

		<section class="card p-4" aria-labelledby="p-email">
			<h2 id="p-email" class="mb-2 font-medium">Sign-in email</h2>
			<form method="POST" action="?/email" use:enhance={submit('email')} class="space-y-2">
				<label class="block text-sm"><span class="mb-1 block text-xs text-muted-foreground">New email address</span><input class="input w-full" type="email" name="email" placeholder={data.email} autocomplete="email" required /></label>
				<label class="block text-sm"><span class="mb-1 block text-xs text-muted-foreground">Current password</span><input class="input w-full" type="password" name="current" autocomplete="current-password" required /></label>
				<p class="text-xs text-muted-foreground">SEOConsole does not send email, so the new address is not checked by a message. Your Google link is dropped; the next Google sign-in must use the new address.</p>
				{#if msgFor('email')?.ok}<p class="text-sm text-good" role="status">{msgFor('email')?.ok}</p>{/if}
				{#if msgFor('email')?.error}<p class="text-sm text-bad" role="alert">{msgFor('email')?.error}</p>{/if}
				<button class="btn" disabled={busy === 'email'}>Change email</button>
			</form>
		</section>

		<section class="card p-4" aria-labelledby="p-pw">
			<h2 id="p-pw" class="mb-2 font-medium">Password</h2>
			<form method="POST" action="?/password" use:enhance={submit('password')} class="space-y-2">
				<input type="email" name="username" value={data.email} autocomplete="username" readonly hidden />
				<label class="block text-sm"><span class="mb-1 block text-xs text-muted-foreground">Current password</span><input class="input w-full" type="password" name="current" autocomplete="current-password" required /></label>
				<label class="block text-sm"><span class="mb-1 block text-xs text-muted-foreground">New password (at least {data.minPassword} characters)</span><input class="input w-full" type="password" name="password" minlength={data.minPassword} maxlength="256" autocomplete="new-password" required /></label>
				<label class="block text-sm"><span class="mb-1 block text-xs text-muted-foreground">Type it again</span><input class="input w-full" type="password" name="confirm" minlength={data.minPassword} maxlength="256" autocomplete="new-password" required /></label>
				{#if msgFor('password')?.ok}<p class="text-sm text-good" role="status">{msgFor('password')?.ok}</p>{/if}
				{#if msgFor('password')?.error}<p class="text-sm text-bad" role="alert">{msgFor('password')?.error}</p>{/if}
				<button class="btn" disabled={busy === 'password'}>Change password</button>
			</form>
			<p class="mt-3 text-xs text-muted-foreground">Forgot it? SEOConsole cannot email you a link. Sign in with Google if you have linked it, or ask an admin for a reset link.</p>
		</section>

		{#if data.googleLogin}
			<section class="card p-4" aria-labelledby="p-google">
				<h2 id="p-google" class="mb-2 font-medium">Sign in with Google</h2>
				{#if data.googleNote}<p class="mb-2 text-sm {data.googleNote.ok ? 'text-good' : 'text-bad'}" role={data.googleNote.ok ? 'status' : 'alert'}>{data.googleNote.text}</p>{/if}
				{#if msgFor('google')?.ok}<p class="mb-2 text-sm text-good" role="status">{msgFor('google')?.ok}</p>{/if}
				{#if msgFor('google')?.error}<p class="mb-2 text-sm text-bad" role="alert">{msgFor('google')?.error}</p>{/if}
				{#if data.googleLinked}
					<p class="mb-2 text-sm text-muted-foreground">A Google account is linked: you can use “Continue with Google” on the sign-in page.</p>
					<form method="POST" action="?/unlinkGoogle" use:enhance><button class="btn">Unlink Google</button></form>
				{:else}
					<p class="mb-2 text-sm text-muted-foreground">Link the Google account you want to sign in with. It may use a different address from the one above. Google only confirms who you are; no Search Console access is asked for.</p>
					<form method="POST" action="?/linkGoogle"><button class="btn btn-primary">Link a Google account</button></form>
				{/if}
			</section>
		{/if}
	</div>
{/if}
