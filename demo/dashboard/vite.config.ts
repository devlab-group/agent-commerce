import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Read-only demo dashboard (docs/contracts.md, demo/dashboard). Talks
// only to the gateway's public HTTP surface — no server-side code here.
export default defineConfig({
  // Anchored to this file, not to `process.cwd()`. Vite resolves a relative
  // root against the working directory, and every way this is launched —
  // `npm run dev:dashboard`, `demo:dashboard`, the compose service — runs
  // `vite --config demo/dashboard/vite.config.ts` from the repository root,
  // where there is no index.html. The dev server then answers `/` with a bare
  // 404 and says nothing about why.
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  server: {
    port: 5173,
  },
});
