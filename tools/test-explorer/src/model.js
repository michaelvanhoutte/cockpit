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
 */

/**
 * @typedef {'backend'|'frontend'|'browser'|'contract'} Column
 *   backend  apps/api/tests/{unit,integration}/**, packages/*\/tests/unit/** (excluding connectors)
 *   frontend apps/web/tests/{unit,service}/**
 *   browser  tests/e2e/** at the repo root
 *   contract packages/connectors/*\/tests/contract/**
 *
 * @typedef {Object} Rule
 * @property {string} concept    The outer describe's text verbatim — a feature area in product
 *                                language ("Capture", "Triage", "Offline"), per testing-strategy.md
 *                                §9.1. Not dotted, not an entity name; see docs/test-explorer-spec.md §2a.
 * @property {string} statement  The inner describe (the rule, in product language); falls back to
 *                                the feature-area text itself when a describe has no children.
 * @property {Column} column
 * @property {string} level      Folder name under tests/: unit, integration, service, e2e, contract.
 * @property {number} cases      it/it.each bodies with at least one real (non-todo) case.
 * @property {number} todoCases  it.todo bodies.
 * @property {string} file       Repo-relative path of the test file.
 * @property {number} line       1-based line of the outer describe.
 *
 * @typedef {Object} ConceptRow
 * @property {string} key
 * @property {string} label
 * @property {Record<Column, number>} counts        contract is null when the area owns no connector package.
 * @property {Rule[]} rules
 * @property {string[]} filesNothingRuns             Repo-relative paths. A file can appear under more than
 *                                                     one area's row — see docs/test-explorer-spec.md §2a.
 * @property {{file: string, line: number}[] | null} branchesNothingTakes
 *   null when no coverage data was found for this run (see Model.coverageAvailable), not when the
 *   count is genuinely zero — those are different facts and must not render the same way.
 *
 * @typedef {Object} Model
 * @property {string} commit
 * @property {string} generatedAt
 * @property {ConceptRow[]} concepts       'Infrastructure' is always last, everything else in registry order.
 * @property {boolean} coverageAvailable
 * @property {string[]} unregisteredAreas  Feature-area names used by some describe but absent from
 *                                          concepts.json. What `--check-concepts` fails the build on (§7).
 * @property {string[]} warnings           Things the analyzer could not determine; never silently dropped.
 */

export const COLUMNS = ['backend', 'frontend', 'browser', 'contract'];

export const INFRASTRUCTURE_KEY = 'infrastructure';
export const INFRASTRUCTURE_LABEL = 'Infrastructure';

/** Totals across every concept row, for the page header. */
export function summarise(model) {
  let rules = 0;
  let filesNothingRuns = 0;
  let branchesNothingTakes = 0;
  for (const concept of model.concepts) {
    rules += concept.rules.length;
    filesNothingRuns += concept.filesNothingRuns.length;
    branchesNothingTakes += concept.branchesNothingTakes?.length ?? 0;
  }
  return { rules, filesNothingRuns, branchesNothingTakes };
}
