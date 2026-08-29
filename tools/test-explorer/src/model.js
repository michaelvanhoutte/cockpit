/**
 * THE CONTRACT.
 *
 * The only file analyze/ and render/ both depend on. analyze/ produces a
 * Model and knows nothing about HTML; render/ consumes a Model and knows
 * nothing about TypeScript, pnpm or the repository layout. Neither imports
 * the other. See docs/test-explorer-spec.md §6.1 for why this split exists
 * and what it buys.
 *
 * This is deliberately NOT the poc/coverage-explorer model. That one held a
 * state (met/thin/gap/later/na) per node per level, inferred from branch
 * count, purity and fan-in. Settled discussion (docs/testing-decisions-wip.md
 * §"What the explorer shows") dropped the inference: a rule lives at exactly
 * one level, so there is no "owed but absent" state to compute. What is left
 * is measurement — counts of what exists, plus real coverage gaps — which is
 * what this model carries.
 *
 * Amended after first use (docs/test-explorer-spec.md §2c): areas are a
 * **tree**, not a flat list — a big area like Dashboards will have real
 * sub-areas (drag-drop, resizing, ...), and a parent's own rule counts are
 * not meant to look like the whole subtree's. Columns are the actual six
 * testing-strategy levels plus Contract, not the coarser backend/frontend/
 * browser grouping the first version collapsed them into.
 *
 * Amended again after second use (docs/test-explorer-spec.md §2d): a rule
 * used to carry only case *counts*; it now carries each case's own text and
 * location, because "3 cases" doesn't answer "what exactly is tested" the
 * way the printed case name does. Every file:line anywhere in the model
 * (a rule, a case, a branch gap) now carries a few lines of surrounding
 * source (`context`) so the report can show what a gap or a rule actually
 * is without leaving the page — reading that from disk at analyze time
 * (analyze/index.js), never over the network, so the report stays one
 * self-contained file.
 */

/**
 * The seven columns, in testing-strategy.md's own order (§2, §3.3). Each
 * `id` is also the level code `analyze/rules.js` assigns to a rule.
 */
export const LEVELS = [
  { id: 'L1', label: 'L1', name: 'Unit', description: 'No real dependencies — pure logic, calculations, branching, edge cases.' },
  { id: 'L2', label: 'L2', name: 'Integration', description: "Real infrastructure the service owns (its own database), no other service." },
  { id: 'L3', label: 'L3', name: 'System', description: 'Backend services wired together at the API level, no browser. n/a with one backend service.' },
  { id: 'F1', label: 'F1', name: 'Frontend unit', description: 'No real dependencies — component and view-model logic.' },
  { id: 'F2', label: 'F2', name: 'Service-frontend', description: "The frontend plus only its own service's backend." },
  { id: 'F3', label: 'F3', name: 'End-to-end', description: 'Everything real, a real browser. The one level mandatory per capability.' },
  { id: 'Contract', label: 'Contract', name: 'Contract', description: 'Scheduled live checks against a third party. n/a for an area with no connector.' },
];

export const LEVEL_IDS = LEVELS.map((l) => l.id);

export const INFRASTRUCTURE_KEY = 'infrastructure';
export const INFRASTRUCTURE_LABEL = 'Infrastructure';

/**
 * `file` is always repo-relative, deliberately — turning that into a clickable
 * link needs to know where the generated report will be opened *from* (a
 * local relative link) or the repo's GitHub URL (a `blob` link), both of
 * which are render concerns (render/client.js), not something analyze/ can
 * know or should care about (docs/test-explorer-spec.md §6.1).
 *
 * @typedef {Object} ContextLine
 * @property {number} line  1-based.
 * @property {string} text
 *
 * @typedef {Object} CodeRef
 * @property {string} file            Repo-relative path.
 * @property {number} line            1-based, the line this ref actually points at.
 * @property {ContextLine[]} context  A window of source around `line` (including `line` itself),
 *                                      trimmed to whichever lines the file actually has — enough
 *                                      to read what's there without leaving the page.
 *
 * @typedef {CodeRef & { text: string }} CaseRef
 *   One `it`/`test` case: `text` is its own description (the string literal given to `it`/
 *   `test`/`.each`, verbatim — an `.each` template like `'$verb in $where'` is kept as written,
 *   since the actual per-row value only exists once the suite runs).
 *
 * @typedef {CodeRef & {
 *   concept: string,
 *   statement: string,
 *   level: string,
 *   cases: CaseRef[],
 *   todoCases: CaseRef[],
 * }} Rule
 *   `concept` is the outer describe's text verbatim — a feature area in product language
 *   ("Capture", "Triage", "Offline"), per testing-strategy.md §9.1. Not dotted, not an entity
 *   name; see docs/test-explorer-spec.md §2a. `statement` is the inner describe (the rule, in
 *   product language); falls back to the feature-area text itself when a describe has no
 *   children. `level` is one of LEVEL_IDS. `line` is the rule's own describe line.
 *
 * @typedef {CodeRef} BranchRef  An untaken branch path's location.
 *
 * @typedef {Object} TreeNode
 * @property {string} key
 * @property {string} label
 * @property {Record<string, number|null>} counts   Keyed by LEVEL_IDS. null means genuinely n/a for
 *                                                    this node (Contract with no connector; any level
 *                                                    when the whole repo doesn't have it yet — see
 *                                                    Model.availableLevels), never a stand-in for zero.
 *                                                    Own rules only — a parent's children carry their
 *                                                    own counts, this is not a subtree sum.
 * @property {Rule[]} rules                          Own rules only, same scope as `counts`.
 * @property {CodeRef[]} filesNothingRuns             Restricted to this node's own registry patterns.
 *                                                      `line` is always 1 (a whole-file gap, not a
 *                                                      specific line) — `context` is the file's own
 *                                                      first few lines, for the same "see it without
 *                                                      leaving the page" reason a branch gap gets one.
 * @property {BranchRef[] | null} branchesNothingTakes
 *   null when no coverage data was found for this run (see Model.coverageAvailable), not when the
 *   count is genuinely zero — those are different facts and must not render the same way.
 * @property {TreeNode[]} children
 *
 * @typedef {Object} Model
 * @property {string} commit
 * @property {string | null} commitUrl   Link to the commit on GitHub, null when the remote isn't GitHub
 *                                        or couldn't be read.
 * @property {string} generatedAt
 * @property {TreeNode[]} tree           Root nodes (no parent) in registry order; 'Infrastructure' last.
 * @property {boolean} coverageAvailable
 * @property {Record<string, boolean>} availableLevels  Keyed by LEVEL_IDS — false means that level is
 *                                                        structurally absent from the whole repo today
 *                                                        (only L3 uses this: it needs a second backend
 *                                                        service to mean anything, per testing-strategy §2),
 *                                                        so every node's count for it renders n/a, not zero.
 * @property {string[]} unregisteredAreas  Feature-area names used by some describe but absent from
 *                                          concepts.json. What `--check-concepts` fails the build on (§7).
 * @property {string[]} warnings           Things the analyzer could not determine; never silently dropped.
 */

/** Totals across every node in the tree, for the page header. */
export function summarise(model) {
  let rules = 0;
  let filesNothingRuns = 0;
  let branchesNothingTakes = 0;
  for (const node of walkTree(model.tree)) {
    rules += node.rules.length;
    filesNothingRuns += node.filesNothingRuns.length;
    branchesNothingTakes += node.branchesNothingTakes?.length ?? 0;
  }
  return { rules, filesNothingRuns, branchesNothingTakes };
}

/** Depth-first walk over every node in a tree, parents before children. */
export function* walkTree(nodes) {
  for (const node of nodes) {
    yield node;
    yield* walkTree(node.children);
  }
}
