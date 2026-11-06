import { defineConfig } from 'vite';

// Builds the control app as one Node program: `pnpm cloud:build`, then `node cloud/dist/main.js`.
export default defineConfig({
	build: { ssr: 'cloud/src/main.ts', outDir: 'cloud/dist', emptyOutDir: true, target: 'node22', sourcemap: false, rollupOptions: { output: { entryFileNames: 'main.js' } } }
});
