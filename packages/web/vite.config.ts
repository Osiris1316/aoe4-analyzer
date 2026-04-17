import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // Expose on network so you can test from your phone
    host: true,
    port: 5173,
    // Proxy /api requests to the Hono backend on port 3001.
    // This means the React app can call '/api/players' and Vite
    // forwards it to 'http://localhost:3001/api/players' automatically.
    // No CORS issues during development.
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
