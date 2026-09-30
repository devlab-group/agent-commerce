import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Read-only demo dashboard. It talks only to the gateway's HTTP routes and
// has no server-side code.
export default defineConfig({
  // Anchored to this file: Vite resolves a relative root against the working
  // directory, and `npm run dev:dashboard`, `demo:dashboard` and the compose
  // service all start Vite from the repository root, which has no index.html.
  // The dev server would then answer `/` with a bare 404.
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  server: {
    port: 5173,
  },
});
