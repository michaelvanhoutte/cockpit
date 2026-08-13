import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

// Dev serves web and API on one origin (vite proxies to wrangler on :8787),
// mirroring production where both live on the same Cloudflare zone. No CORS.
const apiProxy = {
  target: 'http://127.0.0.1:8787',
  changeOrigin: true,
};

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      // The service worker serves the cached app shell so cold open makes
      // zero blocking network requests (architecture §5.2); API calls are
      // never intercepted — the persisted snapshot lives in IndexedDB.
      workbox: {
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/v1\//, /^\/health/, /^\/ingress\//],
        runtimeCaching: [],
      },
      manifest: {
        name: 'Cockpit',
        short_name: 'Cockpit',
        description: 'Unified inbox and dashboards',
        start_url: '/',
        display: 'standalone',
        background_color: '#e3e1f2',
        theme_color: '#6f62b5',
        icons: [
          {
            src: '/icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
        ],
      },
    }),
  ],
  server: {
    proxy: {
      '/v1': apiProxy,
      '/health': apiProxy,
      '/ingress': apiProxy,
    },
  },
});
