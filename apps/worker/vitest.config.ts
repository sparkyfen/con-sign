import { defineConfig } from 'vitest/config';

// Two tiers of tests:
//   - *.test.ts             Pure unit tests, no bindings.
//   - *.integration.test.ts Drive the Hono app via app.fetch() with an
//                           in-memory D1/KV (better-sqlite3 + Map). No
//                           miniflare/workerd boot — fast.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.integration.test.ts'],
  },
});
