//
// The ceiling as something that fails. Every case here is written against a
// listing shaped exactly as `playwright test --list --reporter=json` produces
// one - each spec repeated per project, which is the detail the count turns on.
//

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { asReport, reviewTheTier, walksIn } from './e2e-ceilings.mjs';

const PROJECTS = ['desktop', 'phone'];

/**
 * A listing of one file, from `{ [area]: { [rule]: walkTitles } }`.
 *
 * Each spec is emitted once per project, as the runner lists it: the copies
 * share a file, a line and a title and differ only by id, which is what makes
 * them one walk.
 */
function listing(file, areas) {
  let line = 0;
  return {
    suites: [
      {
        title: file,
        file,
        suites: Object.entries(areas).map(([area, rules]) => ({
          title: area,
          file,
          suites: Object.entries(rules).map(([rule, walks]) => ({
            title: rule,
            file,
            specs: walks.flatMap((title) => {
              line += 1;
              return PROJECTS.map((project) => ({
                title,
                file,
                line,
                column: 5,
                tests: [{ projectName: project }],
              }));
            }),
          })),
        })),
      },
    ],
  };
}

describe('the size of the browser tier is held per product area', () => {
  it('passes while every area is within its ceiling', () => {
    const review = reviewTheTier(
      listing('item-editing.test.ts', {
        'Item editing': { 'a form keeps what is written in it': ['keeps it', 'throws it away'] },
      }),
      { 'Item editing': 2 },
    );

    assert.equal(review.held, true);
    assert.deepEqual(asReport(review).problems, []);
    assert.equal(review.walks, 2);
  });

  it('fails a walk added past the ceiling of its area, naming the area, its ceiling and its count', () => {
    const review = reviewTheTier(
      listing('item-editing.test.ts', {
        'Item editing': { 'a form keeps what is written in it': ['keeps it', 'throws it away', 'one too many'] },
      }),
      { 'Item editing': 2 },
    );

    assert.equal(review.held, false);
    assert.deepEqual(review.over, [{ area: 'Item editing', ceiling: 2, count: 3 }]);
    const [problem] = asReport(review).problems;
    assert.match(problem, /Item editing/);
    assert.match(problem, /ceiling of 2/);
    assert.match(problem, /3 walks/);
  });

  it('passes an area left under its ceiling, and reports the slack', () => {
    const review = reviewTheTier(
      listing('item-editing.test.ts', {
        'Item editing': { 'a form keeps what is written in it': ['keeps it'] },
      }),
      { 'Item editing': 3 },
    );

    assert.equal(review.held, true);
    assert.deepEqual(review.slack, [{ area: 'Item editing', ceiling: 3, count: 1 }]);
    assert.ok(
      asReport(review).lines.some((line) => /Item editing is 2 under its ceiling/.test(line)),
      'the slack is reported, so bringing the ceiling down is the obvious next move',
    );
  });

  it('fails a ceiling no walk declares, rather than passing vacuously', () => {
    const review = reviewTheTier(
      listing('item-editing.test.ts', {
        'Item editing': { 'a form keeps what is written in it': ['keeps it'] },
      }),
      { 'Item editing': 1, Focus: 2 },
    );

    assert.equal(review.held, false);
    assert.deepEqual(review.empty, [{ area: 'Focus', ceiling: 2 }]);
    assert.match(asReport(review).problems.join('\n'), /Focus has a ceiling of 2 .* and no walk declares it/);
  });

  it('fails a walk whose outer describe is in no area, naming the walk', () => {
    const review = reviewTheTier(
      listing('item-editing.test.ts', {
        'Item forms': { 'a form keeps what is written in it': ['keeps it'] },
      }),
      { 'Item editing': 1 },
    );

    assert.equal(review.held, false);
    assert.equal(review.unbudgeted.length, 1);
    const problems = asReport(review).problems.join('\n');
    assert.match(problems, /item-editing\.test\.ts › Item forms › a form keeps what is written in it › keeps it/);
    assert.match(problems, /"Item forms", which is not an area with a ceiling/);
  });

  it('counts a walk once however many projects the runner runs it under', () => {
    const review = reviewTheTier(
      listing('item-editing.test.ts', {
        'Item editing': { 'a form keeps what is written in it': ['keeps it'] },
      }),
      { 'Item editing': 1 },
    );

    assert.equal(review.walks, 1);
    assert.equal(review.held, true);
  });

  it('counts a rule whose cases come from a table as the runner counts them, not as the source reads', () => {
    // `tests/e2e/triage.test.ts` writes one `test()` inside a `for`, and the
    // runner lists a walk per row - at the same line and column, since the
    // call is written once. A count that read the source would say one.
    const file = 'triage.test.ts';
    const fromATable = ['swiping right, towards the picker', 'swiping left, towards dismissing'].flatMap(
      (title) =>
        PROJECTS.map((project) => ({ title, file, line: 148, column: 7, tests: [{ projectName: project }] })),
    );
    const walks = walksIn({
      suites: [
        {
          title: file,
          file,
          suites: [
            {
              title: 'Triage',
              file,
              suites: [
                { title: 'a thumb can read what letting go will do, before letting go', file, specs: fromATable },
              ],
            },
          ],
        },
      ],
    });

    assert.equal(walks.length, 2);
    assert.deepEqual(
      walks.map((walk) => walk.area),
      ['Triage', 'Triage'],
    );
  });
});
