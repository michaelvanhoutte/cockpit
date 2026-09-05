import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./prosemirror-in-jsdom.ts'],
    include: ['*.test.ts'],
    testTimeout: 60_000,
  },
});
