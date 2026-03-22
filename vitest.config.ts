import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Exclude live tests from `npm test` — they require funded wallets
    // Run them manually: npx vitest run src/__tests__/live/
    exclude: [
      'src/__tests__/live/**',
      'node_modules/**',
      'examples/**',
    ],
  },
});
