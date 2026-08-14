/**
 * THE POLICY TABLE.
 *
 * The only file here that encodes judgment rather than measurement. Everything
 * in analyze/ measures; this decides what the measurements oblige. It is kept
 * small on purpose: docs/coverage-reporting-options.md says this piece should
 * stay short enough to read in one sitting, because it is the part a human has
 * to actually agree with.
 *
 * Transcribed from docs/testing-strategy.md §2 and §5, and docs/architecture.md
 * §6.1 and §6.2. When those documents change, this file changes; nothing else
 * in the POC should need to.
 */

/**
 * Layers named in architecture §6.1, and what breaks when code in them is
 * wrong. Set per layer rather than per file: a per-file judgment call is a
 * per-file argument, and it will not survive a deadline.
 *
 * @type {Record<string, import('../model.js').Consequence>}
 */
export const LAYER_CONSEQUENCE = {
  domain: 'corrupts',
  db: 'corrupts',
  http: 'corrupts',
  jobs: 'loses',
  connectors: 'loses',
  ai: 'wrong',
  components: 'wrong',
  pages: 'wrong',
  api: 'wrong',
  root: 'wrong',
};

/** Consequence tiers at or above this are "high blast radius". */
export const HIGH_BLAST = new Set(['corrupts', 'loses']);

/** A module imported by at least this many others is high blast regardless of layer. */
export const HIGH_FAN_IN = 4;

/**
 * A module making at least this many decisions is obligated regardless of its
 * layer's consequence tier. Branch count is not only a yes/no gate: magnitude
 * carries information, because more decisions means more places to be wrong.
 *
 * Without this, no frontend component could ever be obligated (the component
 * layers are tier "wrong" and fan-in is low by nature), which would leave the
 * F1 column permanently amber and quietly contradict strategy §5.1.
 */
export const BRANCHY = 4;

/**
 * Imports that mean "this code needs a harness to run". React is deliberately
 * absent: a component is pure given its props, which is exactly what an F1 test
 * supplies. Anything reaching a database, a network, a scheduler or a browser
 * store is not.
 */
export const IMPURE_IMPORTS = [
  'node:',
  'drizzle-orm',
  'hono',
  '@hono/',
  '@tanstack/react-query',
  'react-dom',
  'wrangler',
  '@cloudflare/',
];

/**
 * Globals with the same meaning. `crypto.getRandomValues` is absent on purpose:
 * it needs no harness, and the entropy is not what a test asserts on.
 */
export const IMPURE_GLOBALS = [
  'fetch',
  'EventSource',
  'WebSocket',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'setTimeout',
  'setInterval',
  'process',
];

/**
 * Share of a module's exports that a test file must actually import before the
 * cell counts as met rather than partial. Blunt, but it is a measurement rather
 * than an opinion, and it is the thing that flagged items.ts (3 of 8) and
 * commands.ts (1 of 7 schemas) in the manual audit.
 */
export const REACH_THRESHOLD = 0.8;

/**
 * Obligations that belong to a node because of what it *is*, not because of
 * what its code does. Modules are handled by the lattice below instead.
 *
 * `owns` is keyed by level; the value is the requirement and the reason shown
 * in the detail panel.
 */
export const KIND_OBLIGATIONS = {
  repo: {
    L3: { require: 'later', why: 'Strategy §2 collapses L2 and L3 while there is a single service, and Cockpit has one. Becomes due with the second service.' },
    F3: { require: 'required', why: 'Strategy §5.1: every capability needs a frontend test proving it works for a user. Tracked per capability, not per node.' },
  },
  // A package with a wrangler config owns real infrastructure, so it owns L2.
  service_backend: {
    L2: { require: 'required', why: 'Owns D1, the queues and the cron triggers. This is the node that owes integration coverage against its own real infrastructure.' },
  },
  service_frontend: {
    F2: { require: 'required', why: 'Strategy §2 F2: prove the frontend and its own backend agree on payload shapes, error handling and loading states.' },
  },
  // Architecture §6.2 writes the connector obligation set out in prose. This is
  // that paragraph, in a form the report can check.
  connector: {
    L1: { require: 'later', why: 'Normalization and sync logic tested in isolation against a fake host, per architecture §6.2.' },
    L2: { require: 'later', why: 'Recorded fixtures built from real responses, per strategy §3.2. Faithful, never hand-invented.' },
    C: { require: 'later', why: 'Scheduled run against the live API. Its only job is to prove the fixtures still match reality, per strategy §3.3.' },
  },
};

/**
 * Decision 3 of the options document, as code.
 *
 * Returns the level this module owes and how strongly, or null for no
 * obligation at any level.
 *
 * @param {import('../model.js').Signals} signals
 * @param {{ frontend: boolean }} ctx
 * @returns {{ level: string, require: 'required'|'later', why: string } | null}
 */
export function moduleObligation(signals, ctx) {
  // Signal 1: does it decide anything? Nothing to discover in a module with no
  // branches, so grey is the honest answer rather than a coverage failure.
  if (signals.branches === 0) return null;

  const highBlast =
    HIGH_BLAST.has(signals.consequence) ||
    signals.fanIn >= HIGH_FAN_IN ||
    signals.branches >= BRANCHY;

  const decisions = plural(signals.branches, 'branch', 'branches');

  // Signal 2: can it be called with plain data?
  if (!signals.pure) {
    return {
      level: ctx.frontend ? 'F2' : 'L2',
      require: 'required',
      why:
        `Impure (${signals.impureReason || 'reaches a real dependency'}) with ${decisions}, so the behaviour ` +
        `belongs at the integration level. Either test it there, or extract the pure core and test that at the ` +
        `unit level, per strategy §2.`,
    };
  }

  // Signal 3: what breaks if it is wrong?
  return {
    level: ctx.frontend ? 'F1' : 'L1',
    require: highBlast ? 'required' : 'later',
    why:
      `Pure with ${decisions}, imported by ${plural(signals.fanIn, 'module', 'modules')}, consequence tier ` +
      `"${signals.consequence}". ` +
      (highBlast ? 'High blast radius, so obligated.' : 'Low blast radius, so eligible rather than obligated.'),
  };
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}
