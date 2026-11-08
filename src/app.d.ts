declare global {
	namespace App {
		interface Locals {
			authed: boolean;
			/** Who is signed in (the owner, or a team member with a role and an optional site scope); null when nobody is. Set in hooks.server.ts. */
			user: import('$lib/server/roles').CurrentUser | null;
		}
	}
}
export {};
