//
// The browser tier's budget, held per product area rather than as one number
// for the tier ("Bring the browser tier back inside a budget", issue 509).
//
// Per area, because the areas are what grow separately: `Item editing` reached
// 33 walks while `Connector management` had one, and a single tier-wide number
// would have let either pay for the other. The ceilings live beside the areas
// themselves, in tools/test-explorer/concepts.json, so there is one list of
// areas rather than two that drift.
//
// **Counted from what the runner will run**, `playwright test --list`, not from
// a read of the source: a walk whose cases come from a table is one `test()`
// call in the file and two walks in the run (`tests/e2e/triage.test.ts`), and
// the budget is about the run.
//
// Pure, so all of it is tested by `node --test` with no browser and no stack;
// scripts/e2e-ceilings.mjs is the listing and the printing around it.
//

/**
 * Every walk the runner will run, once each.
 *
 * **Once each, and that is the whole reason this is not a `length`.** Every
 * spec runs under both projects (`playwright.config.ts`), and the listing
 * reports each project's copy as a separate entry with an id of its own - so
 * the obvious count is double, and a walk that runs on one project only
 * (`test.skip(!isMobile, …)`) is still listed twice and still counts once.
 *
 * `area` is the outer `describe` that names the product area, or `null` for a
 * walk with no `describe` around it at all.
 *
 * @param {{ suites?: unknown[] }} listing `playwright test --list --reporter=json`, parsed
 * @returns {{ area: string | null, where: string, walk: string }[]}
 */
export function walksIn(listing) {
  const found = new Map();
  for (const file of listing.suites ?? []) {
    const path = file.file ?? file.title ?? '';
    for (const spec of specsUnder(file, [])) keep(found, path, null, spec);
    for (const outer of file.suites ?? []) {
      for (const spec of specsUnder(outer, [outer.title])) keep(found, path, outer.title, spec);
    }
  }
  return [...found.values()];
}

/** Every spec below one suite, each carrying the titles of the blocks it sits in. */
function specsUnder(suite, titles) {
  const found = (suite.specs ?? []).map((spec) => ({
    titles: [...titles, spec.title],
    line: spec.line,
    column: spec.column,
  }));
  for (const child of suite.suites ?? []) found.push(...specsUnder(child, [...titles, child.title]));
  return found;
}

/**
 * One walk, keyed by where it is written and what it is called - which is what
 * makes the two projects' copies of it one walk, and the two rows of a table
 * written on one line two.
 */
function keep(found, path, area, spec) {
  const walk = spec.titles.join(' › ');
  found.set(`${path}:${spec.line}:${spec.column}:${walk}`, { area, where: path, walk });
}

/**
 * What the tier holds against what it is allowed.
 *
 * Three ways to fail, and the last two matter as much as the first: a ceiling
 * for an area no walk declares would sit there passing vacuously while the
 * walks it was written for had gone, and a walk under an area with no ceiling
 * is a walk nothing budgets for.
 *
 * @param {{ suites?: unknown[] }} listing `playwright test --list --reporter=json`, parsed
 * @param {Record<string, number>} ceilings area key to the walks it may hold
 */
export function reviewTheTier(listing, ceilings) {
  const walks = walksIn(listing);
  const counted = new Map();
  const unbudgeted = [];
  for (const walk of walks) {
    if (walk.area === null || !Object.hasOwn(ceilings, walk.area)) {
      unbudgeted.push(walk);
      continue;
    }
    counted.set(walk.area, (counted.get(walk.area) ?? 0) + 1);
  }

  const over = [];
  const slack = [];
  const empty = [];
  for (const area of Object.keys(ceilings).sort()) {
    const count = counted.get(area) ?? 0;
    const ceiling = ceilings[area];
    if (count === 0) empty.push({ area, ceiling });
    else if (count > ceiling) over.push({ area, ceiling, count });
    else if (count < ceiling) slack.push({ area, ceiling, count });
  }

  return {
    walks: walks.length,
    counted,
    over,
    slack,
    empty,
    unbudgeted,
    held: over.length === 0 && empty.length === 0 && unbudgeted.length === 0,
  };
}

/** Where a ceiling is raised, named in every failure so the answer is never a hunt. */
export const THE_REGISTRY = 'tools/test-explorer/concepts.json';

/**
 * The review as something to read: what each area holds, then what failed.
 *
 * The slack is reported rather than only the breaches, because an area sitting
 * well under its ceiling is the moment to bring the ceiling down - which is the
 * half of this that keeps working after the first cut.
 *
 * @returns {{ lines: string[], problems: string[] }}
 */
export function asReport(review) {
  const lines = [`${review.walks} walks in the browser tier`];
  for (const [area, count] of [...review.counted].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`  ${area}: ${count}`);
  }
  for (const { area, ceiling, count } of review.slack) {
    lines.push(`  ${area} is ${ceiling - count} under its ceiling of ${ceiling}; bring the ceiling down to ${count}.`);
  }

  const problems = [];
  for (const { area, ceiling, count } of review.over) {
    problems.push(
      `${area} holds ${count} walks, past its ceiling of ${ceiling}. Extend a walk that already reaches that state instead, or raise the ceiling in ${THE_REGISTRY} in this same pull request.`,
    );
  }
  for (const { area, ceiling } of review.empty) {
    problems.push(`${area} has a ceiling of ${ceiling} in ${THE_REGISTRY} and no walk declares it.`);
  }
  for (const { where, walk, area } of review.unbudgeted) {
    problems.push(
      `${where} › ${walk} is under ${area === null ? 'no describe at all' : `"${area}"`}, which is not an area with a ceiling in ${THE_REGISTRY}.`,
    );
  }
  return { lines, problems };
}
