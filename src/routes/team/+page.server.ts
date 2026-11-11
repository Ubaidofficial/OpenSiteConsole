import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { config } from '$lib/server/config';
import { db } from '$lib/server/db';
import { allSites } from '$lib/server/queries';
import { displayName } from '$lib/server/clients';
import { intParam } from '$lib/server/params';
import { hasRole, requireRole, ROLE_LABEL } from '$lib/server/roles';
import { createPasswordReset, pendingResetUserIds, RESET_HOURS } from '$lib/server/selfservice';
import { createInvite, INVITE_DAYS, listPendingInvites, listUsers, MIN_MEMBER_PASSWORD_LENGTH, removeUser, revokeInvite, scopeOf, setUserDisabled, setUserRole, setUserSites, TeamError } from '$lib/server/users';

const DAY = 86_400_000;
/** Shown in demo mode instead of the real table: example people, nothing that can be accepted. */
function demoTeam(now: number) {
	return {
		users: [
			{ id: -1, email: 'sam@example.com', name: 'Sam Rivera', role: 'admin' as 'admin' | 'editor' | 'viewer', sites: null as string[] | null, siteIds: null as number[] | null, createdAt: now - 40 * DAY, lastLoginAt: now - 2 * 3600_000, disabled: false },
			{ id: -2, email: 'alex@example.com', name: 'Alex Chen', role: 'editor' as const, sites: null, siteIds: null, createdAt: now - 21 * DAY, lastLoginAt: now - DAY, disabled: false },
			{ id: -3, email: 'client@example.com', name: 'Client (read-only)', role: 'viewer' as const, sites: ['example.com'], siteIds: null, createdAt: now - 9 * DAY, lastLoginAt: now - 5 * DAY, disabled: false }
		],
		invites: [{ id: -1, email: 'new.writer@example.com', role: 'editor' as const, sites: null, createdAt: now - DAY, expiresAt: now + 6 * DAY, createdBy: 'Owner' }]
	};
}

export const load: PageServerLoad = ({ locals }) => {
	const me = locals.user;
	const canManage = hasRole(me?.role, 'admin');
	const now = Date.now();
	const sites = allSites().map((s) => ({ id: s.id, name: displayName(s.site_url) }));
	const siteName = (id: number) => sites.find((s) => s.id === id)?.name ?? `#${id}`;
	// Only people who manage the team see which sites someone else is limited to.
	const sitesOf = (raw: string | null) => {
		const ids = scopeOf(raw);
		return ids === null ? null : canManage ? ids.map(siteName) : [`${ids.length} site${ids.length === 1 ? '' : 's'}`];
	};
	const real = {
		users: listUsers().map((u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, sites: sitesOf(u.site_ids), siteIds: canManage ? scopeOf(u.site_ids) : null, createdAt: u.created_at, lastLoginAt: u.last_login_at, disabled: !!u.disabled })),
		invites: listPendingInvites(now).map((i) => ({ id: i.id, email: i.email, role: i.role, sites: sitesOf(i.site_ids), createdAt: i.created_at, expiresAt: i.expires_at, createdBy: i.created_by }))
	};
	const team = config.demo ? demoTeam(now) : real;
	return {
		me: me ? { id: me.id, name: me.name, email: me.email, role: me.role, roleLabel: ROLE_LABEL[me.role] } : null,
		canManage,
		demo: config.demo,
		hasPassword: config.hasPassword,
		inviteDays: INVITE_DAYS,
		resetHours: RESET_HOURS,
		pendingResets: canManage && !config.demo ? [...pendingResetUserIds(now)] : [],
		minPassword: MIN_MEMBER_PASSWORD_LENGTH,
		users: team.users,
		invites: team.invites,
		sites: canManage ? sites : [],
		activity: canManage && !config.demo
			? (db().prepare("SELECT at, action, detail FROM audit_log WHERE action LIKE 'invite.%' OR action LIKE 'user.%' ORDER BY id DESC LIMIT 30").all() as { at: number; action: string; detail: string | null }[])
			: []
	};
};

/** Every change here: the hook already required admin; this repeats it, and refuses demo mode (no real invite may exist there). */
function guard(locals: App.Locals) {
	const me = requireRole(locals, 'admin');
	if (config.demo) return { me, refused: fail(403, { error: 'Demo mode: the team shown is an example. Invites and changes are disabled.' }) };
	return { me, refused: null };
}
const msg = (e: unknown) => (e instanceof TeamError ? e.message : 'Something went wrong.');
const siteList = (f: FormData) => [...new Set(f.getAll('site').map(Number).filter((n) => Number.isInteger(n) && n > 0))];

export const actions: Actions = {
	invite: async ({ request, locals }) => {
		const { me, refused } = guard(locals);
		if (refused) return refused;
		if (!config.hasPassword) return fail(400, { error: 'Set ADMIN_PASSWORD first: without it SEOConsole only answers this machine, so nobody you invite could sign in.' });
		const f = await request.formData();
		const known = new Set(allSites().map((s) => s.id));
		try {
			const inv = createInvite({ email: f.get('email'), role: f.get('role'), siteIds: siteList(f).filter((id) => known.has(id)), actor: me });
			return { inviteLink: `${config.origin}/invite/${inv.token}`, inviteEmail: inv.email, inviteRole: ROLE_LABEL[inv.role], inviteExpires: inv.expiresAt };
		} catch (e) {
			return fail(400, { error: msg(e) });
		}
	},
	/** A one-time link for a member who cannot sign in (there is no email sending, so it is copied by hand), like an invite. */
	resetLink: async ({ request, locals }) => {
		const { me, refused } = guard(locals);
		if (refused) return refused;
		if (!config.hasPassword) return fail(400, { error: 'Set ADMIN_PASSWORD first.' });
		try {
			const r = createPasswordReset(intParam((await request.formData()).get('id')), me);
			return { resetLink: `${config.origin}/reset/${r.token}`, resetFor: r.name, resetExpires: r.expiresAt };
		} catch (e) {
			return fail(400, { error: msg(e) });
		}
	},
	revoke: async ({ request, locals }) => {
		const { me, refused } = guard(locals);
		if (refused) return refused;
		try {
			return revokeInvite(intParam((await request.formData()).get('id')), me) ? { ok: 'Invite revoked: the link no longer works.' } : fail(404, { error: 'That invite was already used or revoked.' });
		} catch {
			return fail(400, { error: 'Invalid invite' });
		}
	},
	role: async ({ request, locals }) => {
		const { me, refused } = guard(locals);
		if (refused) return refused;
		const f = await request.formData();
		try {
			const u = setUserRole(intParam(f.get('id')), f.get('role'), me);
			return { ok: `${u.name} is now ${ROLE_LABEL[u.role]}.` };
		} catch (e) {
			return fail(400, { error: msg(e) });
		}
	},
	sites: async ({ request, locals }) => {
		const { me, refused } = guard(locals);
		if (refused) return refused;
		const f = await request.formData();
		const known = new Set(allSites().map((s) => s.id));
		try {
			const ids = f.get('scope') === 'selected' ? siteList(f).filter((id) => known.has(id)) : null;
			if (ids && !ids.length) return fail(400, { error: 'Pick at least one site, or choose all sites.' });
			const u = setUserSites(intParam(f.get('id')), ids, me);
			return { ok: `${u.name} now sees ${u.site_ids ? 'only the chosen sites' : 'all sites'}.` };
		} catch (e) {
			return fail(400, { error: msg(e) });
		}
	},
	disable: async ({ request, locals }) => {
		const { me, refused } = guard(locals);
		if (refused) return refused;
		try {
			const u = setUserDisabled(intParam((await request.formData()).get('id')), true, me);
			return { ok: `${u.name} is disabled and signed out everywhere.` };
		} catch (e) {
			return fail(400, { error: msg(e) });
		}
	},
	enable: async ({ request, locals }) => {
		const { me, refused } = guard(locals);
		if (refused) return refused;
		try {
			const u = setUserDisabled(intParam((await request.formData()).get('id')), false, me);
			return { ok: `${u.name} can sign in again.` };
		} catch (e) {
			return fail(400, { error: msg(e) });
		}
	},
	remove: async ({ request, locals }) => {
		const { me, refused } = guard(locals);
		if (refused) return refused;
		try {
			removeUser(intParam((await request.formData()).get('id')), me);
			return { ok: 'Removed from the team and signed out.' };
		} catch (e) {
			return fail(400, { error: msg(e) });
		}
	}
};
