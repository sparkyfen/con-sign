import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [sveltekit()],
  server: {
    // Proxy /api/* to the local Worker so dev mode talks to a real backend.
    // Run `pnpm --filter @con-sign/worker dev` in another terminal.
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
});
