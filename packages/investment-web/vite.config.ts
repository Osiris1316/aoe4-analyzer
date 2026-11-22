import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The page lives in web/ and builds to dist/, which the Worker serves as static
// assets (wrangler.jsonc). `pnpm dev` runs it on 5173 and sends /api to
// `wrangler dev` on 8787.
export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    // No inline scripts or styles, so the page keeps working under its strict CSP.
    assetsInlineLimit: 0,
  },
  server: {
    host: true,
    port: 5173,
    proxy: { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true } },
  },
});
