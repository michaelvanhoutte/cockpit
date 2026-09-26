import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { manifest } from './manifest';

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
  // esbuild's default minifier is faster but noticeably less aggressive; at
  // the entry's own 200KB budget (architecture, "Performance budgets") that
  // gap was already the difference between passing and failing the gate
  // (found in review, "Give the item's form more room, and put clutter out
  // of the way", issue 480) - terser trades a few seconds of build time for
  // several KB back.
  build: { minify: 'terser' },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      // `crossorigin="use-credentials"` on <link rel="manifest">, which is
      // **inert today and kept as a trap marker**. Static assets are served
      // before the Worker (`run_worker_first` in apps/api/wrangler.jsonc), so
      // nothing gates the manifest and a same-origin request needs no CORS
      // headers either way.
      //
      // What it records: the manifest is the one request a browser makes with
      // credentials omitted, so anything put in front of this app that answers
      // an unauthenticated request with a redirect elsewhere gets rejected by
      // the browser as a cross-origin redirect with no
      // `Access-Control-Allow-Origin` — surfacing as a CORS error, which is
      // what made it cost a day to diagnose behind the perimeter that used to
      // sit here. Removing this line would put that back.
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
        // `/cdn-cgi/` is **Cloudflare's, not ours**: the edge answers it before
        // assets or the Worker see it, so a cached page is never the right
        // answer for one. Leaving it out once broke signing in outright — the
        // shell answered Cloudflare's own callback navigation from cache, the
        // request never left the browser, and the app rendered its own "Not
        // Found" over a URL that was never ours to serve.
        //
        // Deliberately untested, which the testing skill requires saying out
        // loud rather than leaving as a gap. F3 runs Vite's dev server, where
        // this plugin registers no service worker at all, so reaching it needs
        // a real browser holding a real service worker against a deployment.
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
      manifest,
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
