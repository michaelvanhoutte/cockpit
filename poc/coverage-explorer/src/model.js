/**
 * THE CONTRACT.
 *
 * This file is the only thing the analyzer and the renderer share. The analyzer
 * produces a Model and knows nothing about HTML; the renderer consumes a Model
 * and knows nothing about TypeScript, pnpm or the repository layout. Neither
 * side imports the other, ever.
 *
 * That is deliberate, because the shape of the report is the least settled part
 * of this POC (docs/coverage-reporting-options.md, decision 1). Swapping the
 * matrix for a treemap should be a new file under src/render/ and a one-line
 * change in cli.js. Changing how nodes are derived should not touch render/ at
 * all.
 *
 * If you find yourself wanting to add a field here to make one particular
 * rendering easier, that is the signal that the boundary is being eroded.
 */

/**
 * @typedef {'L1'|'L2'|'L3'|'C'|'F1'|'F2'|'F3'} Level
 *   The six levels of docs/testing-strategy.md §2, plus C for the scheduled
 *   contract suite of §3.3.
 *
 * @typedef {'ok'|'thin'|'gap'|'later'|'na'} State
 *   ok    obligation met
 *   thin  tests exist but a meaningful share of the surface is unexercised
 *   gap   required and absent
 *   later eligible or committed, but not yet due
 *   na    this level does not apply to this node
 *
 * @typedef {'repo'|'service'|'pkg'|'layer'|'module'|'connector'|'tooling'} Kind
 *
 * @typedef {'corrupts'|'loses'|'wrong'|'cosmetic'} Consequence
 *   What breaks when this node is wrong. Set per layer in policy/, never per
 *   file, because per-file judgment does not survive contact with a deadline.
 *
 * @typedef {Object} Signals
 * @property {number} branches   Cyclomatic proxy: decisions the module makes.
 * @property {boolean} pure      Callable with plain data, no harness required.
 * @property {number} fanIn      How many other modules import this one.
 * @property {Consequence} consequence
 * @property {string[]} exports  Exported symbol names, used to measure reach.
 * @property {string[]} reached  Exports actually imported by some test file.
 *
 * @typedef {Object} Cell
 * @property {State} state
 * @property {number} count      Tests or assertions attributed to this level.
 * @property {string} [why]      Human-readable reasoning, shown in the panel.
 * @property {'derived'|'annotated'} [source]
 *   Whether the rule produced this cell or a human overrode it in
 *   policy/annotations.js. Rendered differently, so a judgment call is never
 *   mistaken for a measurement.
 *
 * @typedef {Object} Node
 * @property {string} id
 * @property {string} name
 * @property {string} path       Repo-relative.
 * @property {Kind} kind
 * @property {number} [lines]
 * @property {string} [note]
 * @property {boolean} [projected] Node that does not exist yet (see policy).
 * @property {Signals} [signals]
 * @property {Partial<Record<Level, Cell>>} own
 * @property {Node[]} children
 *
 * @typedef {Object} Capability
 * @property {string} name       Command name from the registry.
 * @property {string} handler    Domain function backing it.
 * @property {Record<string, State>} cells
 *
 * @typedef {Object} Model
 * @property {string} commit
 * @property {string} generatedAt
 * @property {Node} root
 * @property {Capability[]} capabilities
 * @property {string[]} warnings Things the analyzer could not determine.
 */

/** Display order. The visual break sits before F1. */
export const LEVELS = [
  { id: 'L1', name: 'Unit' },
  { id: 'L2', name: 'Integration' },
  { id: 'L3', name: 'System' },
  { id: 'C', name: 'Contract' },
  { id: 'F1', name: 'Frontend unit', sep: true },
  { id: 'F2', name: 'Service-frontend' },
  { id: 'F3', name: 'End-to-end' },
];

export const LEVEL_IDS = LEVELS.map((l) => l.id);

/**
 * Roll-up takes the worst state in a subtree, so the order encodes "how much
 * does this need attention". A pending obligation ranks above a met one but
 * below a partial one: not-yet-due is a commitment, not a problem.
 */
export const RANK = { na: 0, ok: 1, later: 2, thin: 3, gap: 4 };

export const STATE_LABEL = {
  ok: 'met',
  thin: 'partial',
  gap: 'absent',
  later: 'not yet due',
  na: 'n/a',
};

/** @param {State[]} states */
export function worst(states) {
  const real = states.filter((s) => s && s !== 'na');
  if (!real.length) return 'na';
  return real.reduce((a, b) => (RANK[b] > RANK[a] ? b : a));
}

/**
 * Computes each node's displayed cells from its own obligations plus everything
 * beneath it, and hangs them on `node.cells`. Mutates, and returns the node.
 *
 * Lives here rather than in the renderer because "what a parent row means" is
 * model semantics: any future renderer needs the same answer.
 *
 * @param {Node} node
 */
export function rollup(node) {
  const kids = (node.children || []).map(rollup);
  /** @type {Record<string, Cell>} */
  const cells = {};

  for (const level of LEVEL_IDS) {
    const mine = node.own?.[level];
    const pool = [];
    if (mine && mine.state !== 'na') pool.push(mine);
    for (const k of kids) {
      const c = k.cells[level];
      if (c && c.state !== 'na') pool.push(c);
    }

    if (!pool.length) {
      cells[level] = { state: 'na', count: 0 };
    } else {
      const w = pool.reduce((a, b) => (RANK[b.state] > RANK[a.state] ? b : a));
      cells[level] = {
        state: w.state,
        count: pool.reduce((sum, c) => sum + (c.count || 0), 0),
        why: mine?.why,
        source: mine?.source,
      };
    }
  }

  node.cells = cells;
  return node;
}

/** Depth-first walk, parents before children. @param {Node} node */
export function* walk(node) {
  yield node;
  for (const child of node.children || []) yield* walk(child);
}
