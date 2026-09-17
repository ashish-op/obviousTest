import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  // Component tests (.tsx) need the automatic JSX runtime to transform
  // without importing React in every file.
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    setupFiles: ['tests/setup.ts'],
    environment: 'node',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
