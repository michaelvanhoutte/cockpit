import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

// Dev serves web and API on one origin (vite proxies to wrangler), mirroring
// production where both live on the same Cloudflare zone. No CORS.
//
// The origin is overridable, and both callers rely on it. The browser tests run
// a second, isolated copy of the stack on other ports against a throwaway
// database (scripts/e2e-stack.mjs), and `pnpm dev` in a git worktree runs on a
// pair of ports derived from that worktree's path (scripts/lib/ports.mjs) - so
// in neither case is the default right, and each passes the address of the
// Wrangler it just started. The default is the primary checkout's, which is
// what `pnpm dev:web` alone gets.
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
      // zero blocking network requests (architecture, "The read model"); API
      // calls are never intercepted — the persisted snapshot lives in IndexedDB.
      workbox: {
        navigateFallback: '/index.html',
        // Four prefixes the shell must never answer for. The first three are
        // this service's own: they are requests for data, and a cached page is
        // not an answer to one.
        //
        // `/cdn-cgi/` is **Cloudflare's, not ours**, and it is here because
        // leaving it out broke signing in. Access completes a sign-in by
        // redirecting the browser to `/cdn-cgi/access/authorized?...` on this
        // hostname; that is a navigation, so the shell answered it from cache
        // and the request never left the browser. The cookie was therefore
        // never set, the app rendered its own "Not Found" over Cloudflare's
        // callback URL, and every API call kept being redirected to the login
        // page - which looks like the app being broken rather than a sign-in
        // that never finished. The origin was always doing the right thing:
        // asked directly, `/cdn-cgi/access/authorized` is answered by Access
        // itself and never reaches this application at all.
        //
        // Deliberately untested, which the testing skill requires saying out
        // loud rather than leaving as a gap - the same gap, for the same
        // reason, as `useCredentials` above. No tier can reach it: F3 runs
        // Vite's dev server, where this plugin registers no service worker at
        // all, and reproducing it needs a real browser holding a real service
        // worker in front of a gated deployment. That is a human step.
        //
        // Note this list is **not** the same as `run_worker_first` in
        // apps/api/wrangler.jsonc, though the first three entries match it.
        // `/cdn-cgi/` must bypass the service worker and must *not* reach the
        // Worker: it belongs to Cloudflare's edge, which handles it before
        // either. The two lists agree about this application's own prefixes
        // and about nothing else.
        navigateFallbackDenylist: [/^\/v1\//, /^\/health/, /^\/ingress\//, /^\/cdn-cgi\//],
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
