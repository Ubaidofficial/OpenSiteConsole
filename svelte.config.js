import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

export default {
	preprocess: vitePreprocess(),
	kit: {
		adapter: adapter(),
		// SvelteKit's built-in form-origin check refuses any form POST that has no Origin header, which includes the OAuth token request a
		// connector's server makes. It cannot exempt one path, so it is switched off here ('*' trusts every origin) and src/hooks.server.ts
		// applies the same rule through crossSiteRefused() to everything except the server-to-server endpoints. Keep the two together.
		csrf: { trustedOrigins: ['*'] },
		// Scripts only from this app (SvelteKit adds a nonce to its own and to app.html's inline script). Inline styles stay
		// allowed because Svelte writes style attributes. Images may come from https (Google avatars, favicons).
		csp: {
			mode: 'nonce',
			directives: {
				'default-src': ['self'],
				'script-src': ['self'],
				'style-src': ['self', 'unsafe-inline'],
				'img-src': ['self', 'data:', 'https:'],
				'font-src': ['self', 'data:'],
				'connect-src': ['self'],
				'frame-ancestors': ['none'],
				'base-uri': ['self'],
				'form-action': ['self'],
				'object-src': ['none']
			}
		}
	}
};
