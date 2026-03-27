import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'tests/unit/**/*.test.js',
      'tests/dom/**/*.test.js',
      'tests/integration/**/*.test.js',
    ],
    environment: 'jsdom',
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['sar-preflight-core.js', 'sar-preflight.js'],
    },
  },
});
