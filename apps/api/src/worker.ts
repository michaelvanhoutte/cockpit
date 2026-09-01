/**
 * What Wrangler deploys: the request handler, and every Durable Object class a
 * binding names.
 *
 * Separate from `index.ts`, which is this package's entry for `apps/web`, and
 * separate for a reason worth knowing before merging the two back together. The
 * store's class extends `DurableObject` from `cloudflare:workers`, a module that
 * exists only in the Workers runtime's own type definitions. `apps/web` compiles
 * this package's source to infer the API contract and cannot resolve it, so
 * exporting the class from `index.ts` breaks the web app's typecheck - loudly,
 * and nowhere near the change that caused it.
 */
export { default, type AppType } from './index.js';
export { AccountStore } from './accounts/store.js';
