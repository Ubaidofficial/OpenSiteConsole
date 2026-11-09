# Team and roles

Invites, roles, sessions and what each role may do.

[Back to the README](../README.md)

## Team and roles

**Unlimited users, free.** The owner (or an admin) invites people from the **Team** page; each gets a role, and editors and viewers can be limited to some sites.

| Role | Can |
|---|---|
| **Owner** | Everything. The owner is whoever signs in with `ADMIN_PASSWORD` (or `ADMIN_PASSWORD_HASH`); it is not a row in the database, so it can never be disabled, demoted or locked out. Without a password, the app answers only this machine, and that machine is the owner. |
| **Admin** | Everything, including the team (invite, revoke, change roles and sites, disable, remove), API keys and app sign-ins on the MCP page, connections (Google accounts, Bing, GA4, Tag Manager, Clarity, OpenSEO, CrUX), adding or removing Search Console properties, site settings and the Clarity install through Tag Manager. Always sees every site. |
| **Editor** | Uses the app: sync, mark actions, notes, SEO tests, indexing checks, URL and sitemap submissions, IndexNow, the request list, digests, Google updates. Cannot connect or disconnect accounts, manage API keys, change site settings or manage the team. |
| **Viewer** | Sees every page; every request that changes something is refused. |

- **Invites.** An invite is a link: **there is no email sending in SEOConsole**, so you copy the link (shown once) and send it yourself. It works once, expires after 7 days, and only a SHA-256 of it is stored. The person opens it, chooses a name and a password (at least 10 characters) and is signed in. A new invite for the same address replaces the old link; pending invites can be revoked. Invite links have their own per-visitor attempt limit (10 bad links per 15 minutes). Invites need `ADMIN_PASSWORD` to be set.
- **Signing in.** Team members sign in with email and password. The owner can leave the email empty and use the admin password as before (the owner password is accepted whatever the email field holds). A wrong email, a wrong password and a disabled account all get the same answer, and an unknown email costs the same password check as a real one. The existing per-visitor attempt limit covers both.
- **Sessions** record who is signed in. A role or site change applies on the next request; disabling or removing someone signs them out everywhere; changing their password, or the owner password, ends their sessions.
- **Enforced on the server, for every request.** One table (`src/lib/server/roles.ts`) gives each form action and endpoint the role it needs, and `src/hooks.server.ts` applies it before any action runs; anything not in the table needs admin. A test reads every route file and fails if an action is missing from the table. Buttons are not hidden to enforce anything (a viewer sees a note that changes will be refused).
- **Limited to some sites.** Such a person sees only those sites: other sites' pages answer "Unknown site", the Dashboard lists only theirs, and pages that cover every site (Actions, Portfolio, Sitemaps, Digest, Accounts, Connect, MCP) are closed to them. A deleted site leaves every scope, as it does for API keys.
- **Audit log.** Invites created, accepted and revoked, role and site changes, members disabled, enabled and removed, each with who did it; admins see them on the Team page.
- **Demo mode** shows example people and a pending invite on the Team page; invites and changes are disabled there.
- `READ_ONLY=1` still applies to everyone, the owner included.
