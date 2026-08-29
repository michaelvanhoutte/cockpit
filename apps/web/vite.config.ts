import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

// Dev serves web and API on one origin (vite proxies to wrangler on :8787),
// mirroring production where both live on the same Cloudflare zone. No CORS.
//
// The origin is overridable because the browser tests run a second, isolated
// copy of the stack on other ports against a throwaway database
// (scripts/e2e-stack.mjs), and it has to reach *its* Wrangler rather than the
// one `pnpm dev` may also be running.
const apiProxy = {
  target: process.env.COCKPIT_API_ORIGIN ?? 'http://127.0.0.1:8787',
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
