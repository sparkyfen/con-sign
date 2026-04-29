import { defineConfig } from 'vitest/config';

// Pure-logic unit tests run in plain Node (Web Crypto is built in for >=20).
// Integration tests that need D1/KV/RL bindings will move to a separate
// vitest project using @cloudflare/vitest-pool-workers when we get there.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.integration.test.ts'],
  },
});
