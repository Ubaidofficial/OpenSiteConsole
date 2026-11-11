<script lang="ts">
	import { ConfirmButton } from '$lib/components/ui/confirm';
	import { enhance } from '$app/forms';
	import { ago } from '$lib/format';
	import Explainer from '$lib/components/Explainer.svelte';
	let { data, form } = $props();

	const LABEL = { owner: 'Owner', admin: 'Admin', editor: 'Editor', viewer: 'Viewer' } as const;
	const chipClass = (role: string) => (role === 'owner' || role === 'admin' ? 'chip !border-[color:var(--warn)]' : role === 'editor' ? 'chip !border-[color:var(--good)]' : 'chip');
	let inviteRole = $state('editor');
	let copied = $state(false);
	async function copy(text: string) {
		try {
			await navigator.clipboard.writeText(text);
			copied = true;
			setTimeout(() => (copied = false), 1500);
		} catch {
			/* the link stays selectable on the page */
		}
	}
	const keep = () => async ({ update }: { update: (o?: { reset?: boolean }) => Promise<void> }) => update({ reset: false });
</script>

<h1 class="mb-1 text-lg font-semibold">Team</h1>
<Explainer lead="Invite as many people as you like, free, each with a role. The owner password always works.">
	<p><b>Owner</b>: whoever signs in with the admin password (<code>ADMIN_PASSWORD</code>). Everything, and it can never be locked out. <b>Admin</b>: everything, including the team, API keys, connections and site settings. <b>Editor</b>: uses the app (syncs, marks actions, runs tests and checks, submits URLs and sitemaps) but cannot connect or disconnect accounts, manage API keys, change site settings or manage the team. <b>Viewer</b>: sees every page and can change nothing.</p>
	<p>Editors and viewers can be limited to some sites; they then see only those sites, and pages that cover every site are closed to them. Every rule is enforced on the server, not by hiding buttons.</p>
	<p>There is no email sending in SEOConsole: an invite is a link you copy and send yourself. It is shown once, works once and expires after {data.inviteDays} days; only a hash of it is stored.</p>
</Explainer>

{#if data.demo}<p class="mb-4 text-sm text-muted-foreground"><span class="chip">demo</span> These people are examples. Invites and changes are disabled in demo mode.</p>{/if}
{#if !data.hasPassword && !data.demo}<p class="mb-4 text-sm text-warn">Set <code>ADMIN_PASSWORD</code> before inviting anyone: without it SEOConsole only answers this machine.</p>{/if}
{#if data.me && !data.canManage}<p class="mb-4 text-sm text-muted-foreground">You are signed in as {data.me.name} ({data.me.roleLabel}). Only the owner and admins can invite people or change roles.</p>{/if}

{#if form?.inviteLink}
	<div class="card mb-4 border-[color:var(--good)] p-4">
		<p class="mb-1 text-sm font-medium">Invite link for <span class="pii">{form.inviteEmail}</span> ({form.inviteRole}). Copy it now: it is shown only once.</p>
		<div class="flex flex-wrap items-center gap-2">
			<code class="block min-w-0 flex-1 break-all rounded bg-black/5 p-2 text-sm dark:bg-white/10">{form.inviteLink}</code>
			<button type="button" class="btn" onclick={() => copy(form!.inviteLink!)}>{copied ? 'Copied' : 'Copy link'}</button>
		</div>
		<p class="mt-2 text-xs text-muted-foreground">SEOConsole does not send email: send this link yourself. It works once and expires {new Date(form.inviteExpires!).toLocaleDateString()}.</p>
	</div>
{/if}

{#if form?.resetLink}
	<div class="card mb-4 border-[color:var(--good)] p-4">
		<p class="mb-1 text-sm font-medium">Password reset link for <span class="pii">{form.resetFor}</span>. Copy it now: it is shown only once.</p>
		<div class="flex flex-wrap items-center gap-2">
			<code class="block min-w-0 flex-1 break-all rounded bg-black/5 p-2 text-sm dark:bg-white/10">{form.resetLink}</code>
			<button type="button" class="btn" onclick={() => copy(form!.resetLink!)}>{copied ? 'Copied' : 'Copy link'}</button>
		</div>
		<p class="mt-2 text-xs text-muted-foreground">SEOConsole does not send email: send this link to them yourself, by a channel you trust. It works once and expires {new Date(form.resetExpires!).toLocaleString()}. Using it signs them out everywhere else.</p>
	</div>
{/if}

{#if data.canManage}
	<section class="card mb-6 p-4">
		<h2 class="mb-2 font-medium">Invite someone</h2>
		<form method="POST" action="?/invite" use:enhance class="space-y-3 text-sm">
			<div class="flex flex-wrap gap-2">
				<label class="min-w-56 flex-1"><span class="sr-only">Email</span><input class="input w-full" type="email" name="email" placeholder="Email address" required disabled={data.demo} /></label>
				<select class="input" name="role" aria-label="Role" bind:value={inviteRole} disabled={data.demo}>
					<option value="viewer">Viewer: read only</option>
					<option value="editor">Editor: use the app</option>
					<option value="admin">Admin: everything</option>
				</select>
				<button class="btn btn-primary" disabled={data.demo || !data.hasPassword}>Create invite link</button>
			</div>
			{#if inviteRole !== 'admin' && data.sites.length}
				<details>
					<summary class="cursor-pointer text-xs text-muted-foreground">Limit to some sites (none ticked = all sites)</summary>
					<div class="mt-2 grid max-h-40 grid-cols-1 gap-1 overflow-y-auto sm:grid-cols-2">
						{#each data.sites as s}<label class="flex items-center gap-2"><input type="checkbox" name="site" value={s.id} /> <span class="pii">{s.name}</span></label>{/each}
					</div>
				</details>
			{/if}
		</form>
	</section>
{/if}

<h2 class="mb-2 font-medium">People</h2>
<div class="card overflow-x-auto">
	<table class="w-full">
		<thead><tr><th class="th">Name</th><th class="th">Role</th><th class="th">Sites</th><th class="th">Last sign-in</th><th class="th relative"><span class="sr-only">Actions</span></th></tr></thead>
		<tbody>
			<tr>
				<td class="td">Owner<div class="text-xs text-muted-foreground">Signs in with the admin password</div></td>
				<td class="td"><span class={chipClass('owner')}>Owner</span></td>
				<td class="td text-xs">all sites</td>
				<td class="td text-xs text-muted-foreground">{data.me?.role === 'owner' ? 'you' : ''}</td>
				<td class="td"></td>
			</tr>
			{#each data.users as u (u.id)}
				<tr class={u.disabled ? 'opacity-60' : ''}>
					<td class="td"><span class="pii">{u.name}</span>{#if data.me?.id === u.id}<span class="chip ml-2">you</span>{/if}{#if u.disabled}<span class="chip ml-2 text-bad">disabled</span>{/if}{#if data.pendingResets.includes(u.id)}<span class="chip ml-2 text-warn" title="A reset link was made and not used yet">reset pending</span>{/if}<div class="text-xs text-muted-foreground"><span class="pii">{u.email}</span></div></td>
					<td class="td"><span class={chipClass(u.role)}>{LABEL[u.role]}</span></td>
					<td class="td text-xs"><span class="pii">{u.sites ? u.sites.join(', ') : 'all sites'}</span></td>
					<td class="td text-xs text-muted-foreground">{u.lastLoginAt ? ago(u.lastLoginAt) : 'never'}</td>
					<td class="td text-right">
						{#if data.canManage && !data.demo && data.me?.id !== u.id}
							<div class="flex flex-wrap items-center justify-end gap-1.5">
								<form method="POST" action="?/role" use:enhance={keep} class="flex items-center gap-1">
									<input type="hidden" name="id" value={u.id} />
									<select name="role" class="input text-xs" aria-label="Role for {u.name}">
										{#each ['viewer', 'editor', 'admin'] as r}<option value={r} selected={u.role === r}>{LABEL[r as 'viewer']}</option>{/each}
									</select>
									<button class="btn text-xs">Save</button>
								</form>
								{#if !u.disabled && data.me?.id !== u.id && !data.demo}
									<form method="POST" action="?/resetLink" use:enhance><input type="hidden" name="id" value={u.id} /><ConfirmButton class="btn text-xs" title="Make a password reset link for {u.name}?" description="Any reset link made earlier stops working. The new one is shown once; you send it to them. Using it signs them out everywhere else." confirmLabel="Make link">Reset password</ConfirmButton></form>
								{/if}
								{#if u.disabled}
									<form method="POST" action="?/enable" use:enhance><input type="hidden" name="id" value={u.id} /><button class="btn text-xs">Enable</button></form>
								{:else}
									<form method="POST" action="?/disable" use:enhance><input type="hidden" name="id" value={u.id} /><ConfirmButton class="btn text-xs" title="Disable {u.name}?" description="They are signed out everywhere and cannot sign in until enabled again." confirmLabel="Disable">Disable</ConfirmButton></form>
								{/if}
								<form method="POST" action="?/remove" use:enhance><input type="hidden" name="id" value={u.id} /><ConfirmButton class="btn btn-danger text-xs" title="Remove {u.name}?" description="They lose access at once. To let them back in, send a new invite." confirmLabel="Remove">Remove</ConfirmButton></form>
							</div>
							{#if u.role !== 'admin' && data.sites.length}
								<details class="mt-1 text-left text-xs">
									<summary class="cursor-pointer text-muted-foreground">Sites</summary>
									<form method="POST" action="?/sites" use:enhance={keep} class="mt-1 space-y-1">
										<input type="hidden" name="id" value={u.id} />
										<label class="flex items-center gap-2"><input type="radio" name="scope" value="all" checked={!u.siteIds} /> All sites</label>
										<label class="flex items-center gap-2"><input type="radio" name="scope" value="selected" checked={!!u.siteIds} /> Only these:</label>
										<div class="grid max-h-32 grid-cols-1 gap-1 overflow-y-auto pl-5">
											{#each data.sites as s}<label class="flex items-center gap-2"><input type="checkbox" name="site" value={s.id} checked={u.siteIds?.includes(s.id)} /> <span class="pii">{s.name}</span></label>{/each}
										</div>
										<button class="btn text-xs">Save sites</button>
									</form>
								</details>
							{/if}
						{/if}
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>
{#if !data.users.length}<p class="mt-2 text-xs text-muted-foreground">Nobody else yet.{#if data.canManage} Create an invite link above.{/if}</p>{/if}

<h2 class="mt-6 mb-2 font-medium">Pending invites</h2>
<div class="card overflow-x-auto">
	<table class="w-full">
		<thead><tr><th class="th">Email</th><th class="th">Role</th><th class="th">Sites</th><th class="th">Expires</th><th class="th">Invited by</th><th class="th relative"><span class="sr-only">Actions</span></th></tr></thead>
		<tbody>
			{#each data.invites as i (i.id)}
				<tr>
					<td class="td"><span class="pii">{i.email}</span></td>
					<td class="td"><span class={chipClass(i.role)}>{LABEL[i.role]}</span></td>
					<td class="td text-xs"><span class="pii">{i.sites ? i.sites.join(', ') : 'all sites'}</span></td>
					<td class="td text-xs text-muted-foreground">{new Date(i.expiresAt).toLocaleDateString()}</td>
					<td class="td text-xs text-muted-foreground"><span class="pii">{i.createdBy ?? ''}</span></td>
					<td class="td text-right">{#if data.canManage && !data.demo}<form method="POST" action="?/revoke" use:enhance><input type="hidden" name="id" value={i.id} /><ConfirmButton class="btn text-xs" title="Revoke this invite?" description="The link stops working at once." confirmLabel="Revoke">Revoke</ConfirmButton></form>{/if}</td>
				</tr>
			{:else}<tr><td class="td text-muted-foreground" colspan="6">No pending invites.</td></tr>{/each}
		</tbody>
	</table>
</div>

{#if data.activity.length}
	<h2 class="mt-8 mb-1 font-medium">Team activity</h2>
	<p class="mb-2 text-xs text-muted-foreground">Invites made, accepted and revoked; roles, sites and access changed. Newest first.</p>
	<div class="card overflow-x-auto">
		<table class="w-full">
			<thead><tr><th class="th">When</th><th class="th">What</th><th class="th">Details</th></tr></thead>
			<tbody>
				{#each data.activity as a}
					<tr>
						<td class="td whitespace-nowrap text-xs text-muted-foreground">{ago(a.at)}</td>
						<td class="td text-xs"><code>{a.action}</code></td>
						<td class="td max-w-[40rem] truncate text-xs text-muted-foreground"><span class="pii" title={a.detail ?? ''}>{a.detail ?? ''}</span></td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{/if}
