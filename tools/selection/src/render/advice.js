/**
 * What to do about each rule that forces a full run, in the rule's own words.
 * Keyed by job and rule, because one rule name means different things in the
 * two jobs: a file outside every package forces every Vitest package because
 * its import graph cannot attribute it, and every E2E walk because no area
 * owns it. A rule absent from here gets `unknownAdvice`, never another's.
 *
 * The rule names are the ones scripts/lib/test-selection.mjs and
 * scripts/lib/e2e-selection.mjs write into the record.
 */

const eventForcesAll = 'Expected on a push to main, which runs everything by design; nothing to fix.';

const vitest = {
  'push to main': eventForcesAll,
  'not a pull request': 'Not a pull request event, so nothing to select from. Nothing to fix.',
  'diff unreadable': 'The job could not read the diff, so it ran everything rather than guess. A recurring one is a CI fault: fix the checkout.',
  'any tsconfig': 'A tsconfig can extend another package’s, so it forces every package, and should.',
  'outside every package':
    'A file outside every package’s directory forces every package, since the import graph cannot attribute it. Fix: move the path under a package, or narrow the rule for files no test can depend on.',
  'own vitest config': 'A package’s own Vitest config changes how its whole suite runs, so it forces that package. Expected; nothing to fix.',
  'own package.json': 'A package’s own package.json can change what its tests resolve, so it forces that package. Expected; nothing to fix.',
  'own wrangler config': 'A package’s Wrangler config is what its suite runs against, so it forces that package. Expected; nothing to fix.',
  'own migration': 'A migration forces its own package, since Vitest’s graph does not see the schema. Expected; nothing to fix.',
  'own global setup': 'A global setup runs once for the whole process, outside any test file’s imports, so it forces its package. Expected; nothing to fix.',
};

const e2e = {
  'push to main': eventForcesAll,
  'not a pull request': 'Not a pull request event, so nothing to select from. Nothing to fix.',
  'diff unreadable': 'The job could not read the diff, so it ran every spec rather than guess. A recurring one is a CI fault: fix the checkout.',
  'no product file in the diff': 'Nothing in the diff places a walk, so every spec ran. A pull request that changes only tests or tooling lands here.',
  'e2e support, registry or config': 'Support code, the area registry or the Playwright config is shared by every walk, so it forces every spec, and should.',
  'any tsconfig': 'A tsconfig can extend another package’s, so it forces every walk, and should.',
  'outside every package': 'A workflow, the lockfile or a root config forces every walk, and should.',
  'spec with no area': 'A changed spec whose walks no area owns cannot be placed, so every walk ran. Fix: give the spec’s walks an area in the registry.',
  'owned by no concept':
    'The area registry cannot place this file, so every walk ran. A new source file or another tier’s test file lands here. Fix: place a file by what imports it (issue 1275, "Make the E2E (F3) selection fire: place a changed file by what imports it"), not by adding it to the registry.',
  'the selection failed': 'The selection step itself failed, so the job ran every spec. Read that job’s log for the cause.',
};

export const unknownAdvice = 'No advice is written for this rule yet.';

const table = { Vitest: vitest, E2E: e2e };

/** The advice for `rule` under job `tier`, or the neutral line where this page has none. */
export function adviceFor(tier, rule) {
  const advice = table[tier];
  return advice && Object.hasOwn(advice, rule) ? advice[rule] : unknownAdvice;
}
