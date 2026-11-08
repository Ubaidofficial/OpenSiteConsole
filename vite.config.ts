import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	// Several suites build whole demo datasets (hundreds of thousands of rows): a few seconds alone, longer when files run in parallel on a busy machine.
	test: { include: ['tests/**/*.test.ts'], testTimeout: 30_000 }
});
