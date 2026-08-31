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
      // `crossorigin="use-credentials"` on <link rel="manifest">. Without it the
      // manifest is the one request the browser makes with credentials omitted,
      // so Cloudflare Access (deployment.md, "All three environments are gated
      // with Cloudflare Access") sees no session cookie, 302s it to the login
      // page on another origin, and the browser rejects that cross-origin
      // redirect with a CORS error. Every other request carries the cookie and
      // is unaffected, which is what makes it look like a CORS bug rather than
      // an auth one. Nothing to undo when Access goes away: same-origin
      // requests need no CORS headers, so this is inert without a gate.
      //
      // Deliberately untested, which the testing skill requires saying out loud
      // rather than leaving as a gap. No tier can reproduce the bug: F3 runs
      // Vite's dev server, where this plugin injects no manifest link at all,
      // and an F3 run against a deployment ("Run the F3 suite against a
      // deployed environment, as its own account", issue #64) authenticates with
      // CF-Access-Client-Id/Secret *headers*, which Playwright sends on every
      // request including this one — so it would pass with or without the fix.
      // The bug is specifically about cookies being omitted. Proving it needs a
      // real browser session against a gated deployment, which is a human step.
      useCredentials: true,
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
