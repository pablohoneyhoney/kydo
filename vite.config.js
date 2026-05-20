import { defineConfig } from 'vite';

// Kydo runs on a dedicated screen — keep it simple.
// Phase 2+ will proxy API calls through server.js on :5175.
export default defineConfig({
  root: '.',
  publicDir: 'public',
  server: {
    port: 5174,
    strictPort: true,
    host: true, // listen on all interfaces so the phone remote (Phase 4) can reach it on LAN
    proxy: {
      '/api': {
        target: 'http://localhost:5175',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
