import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: { include: ['test/**/*.test.ts'], testTimeout: 300_000, hookTimeout: 180_000, fileParallelism: false, reporters: ['verbose'] },
	// The test imports the real app modules from ../../../../src (outside this folder).
	server: { fs: { strict: false } }
});
