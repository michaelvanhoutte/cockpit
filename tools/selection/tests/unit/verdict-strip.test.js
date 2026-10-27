import { describe, expect, it } from 'vitest';

import { buildModel } from '../../src/model.js';
import { renderHtml } from '../../src/render/html.js';

const NOW = new Date('2026-02-15T00:00:00Z');

const file = ({ path, status = 'passed' }) => ({ path, level: 'unit', status, selectedBy: null });
const pkg = ({ name = '@cockpit/pkg', dir = 'apps/pkg', mode = 'changed', reason = null, files = [] }) => ({ name, dir, mode, reason, report: 'written', files });
const record = (packages) => ({ event: 'pull_request', baseCommit: 'abc123', changedFiles: [], packages });
const forced = (rule, path) => ({ mode: 'full', reason: { rule, path }, files: [] });
const e2eTier = (overrides) => pkg({ name: 'e2e', dir: 'tests/e2e', ...overrides });

let nextNumber = 1;
function aPull({ test = null, e2e = null, mergedAt = '2026-02-14T00:00:00Z' } = {}) {
  const number = nextNumber++;
  return {
    pull: { number, title: `Pull ${number}`, url: `https://github.com/o/r/pull/${number}`, mergedAt },
    prRun: test || e2e ? { id: number * 10, testDurationMs: 60_000, record: test ? record(test) : null, e2eRecord: e2e ? record(e2e) : null } : null,
    mainRun: null,
    files: test || e2e ? null : ['docs/notes.md'],
  };
}
const times = (count, make) => Array.from({ length: count }, (_, index) => make(index));

const render = (pulls, { windows = [7, 14] } = {}) => renderHtml(buildModel({ pulls, now: NOW, requestedDays: 14, coveredSince: new Date('2026-01-01'), repo: 'o/r', windows }));

/** The headline table's row for `label`, as html. */
const rowOf = (html, label) => html.match(new RegExp(`<tr class="[^"]*"><th scope="row">${label}[\\s\\S]*?</tr>`))?.[0] ?? '';
/** The rule table's row for a rule's name. */
const ruleRow = (html, rule) => html.match(new RegExp(`<tr class="rule [^"]*">\\s*<td>[^<]*</td>\\s*<td class="rulename">${rule}[\\s\\S]*?</tr>`))?.[0] ?? '';
const strip = (html) => html.match(/<div class="verdict[^"]*">[\s\S]*?<\/div>\s*(?=<div class="note">)/)?.[0] ?? '';

/** A window where E2E ran every spec on all `total` pull requests because no area owns what changed, and Test ran everything on `testForced` of them. */
const crossedWindow = ({ total = 20, testForced = 10 } = {}) =>
  times(total, (index) =>
    aPull({
      test: [index < testForced ? pkg(forced('outside every package', `scripts/f${index}.mjs`)) : pkg({ mode: 'changed' })],
      e2e: [e2eTier(forced('owned by no concept', `apps/api/src/f${index}.ts`))],
    }),
  );

/** A window in which every bar is read and none is crossed: a hot test selected on 8 of 20. */
const quietWindow = () =>
  times(20, (index) =>
    aPull({
      test: [pkg({ mode: 'changed', files: [file({ path: 'apps/pkg/tests/unit/hot.test.ts', status: index < 8 ? 'passed' : 'not run' })] })],
      e2e: [e2eTier({ mode: 'changed' })],
    }),
  );

describe('Test selection report', () => {
  describe('the page draws what the model says about each bar', () => {
    it('two crossed bars are named in the strip with their figure, threshold and leading rule, and their rows are red', () => {
      const html = render(crossedWindow());
      const text = strip(html);
      expect(text).toContain('2 bars crossed in the 14-day window');
      expect(text).toContain('E2E forced to run every spec on 20 of 20 pull requests (100%)');
      expect(text).toContain('bar 25%');
      expect(text).toContain('One rule does it: <i>owned by no concept</i>, 20 of those 20.');
      expect(text).toContain('Test forced to run everything on 10 of 20 pull requests (50%)');
      expect(text).toContain('One rule does it: <i>outside every package</i>, 10 of those 10');
      expect(rowOf(html, 'E2E forced to run every spec')).toMatch(/^<tr class="crossed">/);
      expect(rowOf(html, 'Test forced to run everything')).toMatch(/^<tr class="crossed">/);
    });

    it('a leading rule that forced most but not all is introduced as "mostly"', () => {
      const pulls = times(20, (index) => aPull({ test: [index < 4 ? pkg(forced('outside every package', 'a.mjs')) : pkg(forced('any tsconfig', 'tsconfig.json'))], e2e: [e2eTier({ mode: 'changed' })] }));
      expect(strip(render(pulls))).toContain('Mostly <i>any tsconfig</i>, 16 of the 20.');
    });

    it('no bar crossed is a green strip saying so', () => {
      const html = render(quietWindow());
      expect(strip(html)).toMatch(/^<div class="verdict ok">/);
      expect(strip(html)).toContain('No bar crossed in the 14-day window');
      expect(html).not.toContain('<tr class="crossed">');
    });

    it('a bar that could not be read is named as unread in the strip’s foot and grey in its row, never green', () => {
      // Twenty documentation-only pull requests: neither job ran, so neither forced-full figure exists.
      const html = render(times(20, () => aPull()));
      expect(strip(html)).toContain('Unread: E2E forced to run every spec (the window cannot give the figure); Test forced to run everything (the window cannot give the figure).');
      const row = rowOf(html, 'Test forced to run everything');
      expect(row).toMatch(/^<tr class="unread">/);
      expect(row).not.toContain('within');
      expect(row).not.toContain('crossed');
      expect(row).toContain('unread');
    });

    it('a window too small to read leaves the strip neither red nor green, and gives the window as the reason', () => {
      const html = render(crossedWindow({ total: 12, testForced: 12 }));
      expect(strip(html)).toMatch(/^<div class="verdict unread">/);
      expect(strip(html)).toContain('No bar could be read in the 14-day window');
      expect(strip(html)).toContain('the window holds 12 merged pull requests, and a bar needs 20');
      expect(html).not.toContain('class="fig crossed"');
      expect(html).not.toContain('class="fig within"');
    });

    it('a partial window says how much of the 14 days it covers', () => {
      const model = buildModel({ pulls: crossedWindow(), now: NOW, requestedDays: 14, coveredSince: new Date('2026-02-05'), repo: 'o/r' });
      expect(strip(renderHtml(model))).toContain('only 10 of its 14 days covered');
    });

    it('only the 14-day column is coloured; the 7-day column shows the same figure plain', () => {
      const row = rowOf(render(crossedWindow()), 'E2E forced to run every spec');
      const [, sevenDays, fourteenDays] = row.split('<td class="num">');
      expect(sevenDays).toContain('<span class="fig">20</span>');
      expect(fourteenDays).toContain('<span class="fig crossed">20</span>');
    });

    it('a figure carries its bar beside it in the headline table', () => {
      const html = render(quietWindow());
      expect(rowOf(html, 'Misses')).toContain('<td class="bar">any miss</td>');
      expect(rowOf(html, 'Test forced to run everything')).toContain('25% of pull requests that ran');
    });

    it('a test selected on every pull request that could have skipped it draws no tile and crosses no bar', () => {
      const html = render(times(20, () => aPull({ test: [pkg({ mode: 'changed', files: [file({ path: 'apps/pkg/tests/unit/hot.test.ts' })] })], e2e: [e2eTier({ mode: 'changed' })] })));
      expect(strip(html)).toContain('No bar crossed in the 14-day window');
      expect(html).not.toContain('A test selected on nearly every pull request');
      expect(html).not.toContain('most-selected');
    });
  });

  describe('a rule’s row shows its own advice above its paths', () => {
    const forcedBy = (rule, path, count = 1) => times(count, () => aPull({ test: [pkg(forced(rule, path))] }));

    it('puts the advice under the rule’s name, its share beside it, and the paths folded below, worst first', () => {
      const html = render([...forcedBy('outside every package', 'scripts/rare.mjs'), ...forcedBy('outside every package', 'scripts/common.mjs', 3)]);
      const row = ruleRow(html, 'outside every package');
      expect(row).toContain('<span class="advice">A file outside every package’s directory forces every package');
      expect(row).toContain('<span class="fig">4</span><span class="of">of 4 &middot; 100%</span>');
      expect(html).toContain('<summary>2 paths, worst first</summary>');
      expect(html.indexOf('scripts/common.mjs')).toBeGreaterThan(-1);
      expect(html.indexOf('scripts/common.mjs')).toBeLessThan(html.indexOf('scripts/rare.mjs'));
    });

    it('gives the same rule name the advice of its own job', () => {
      const html = render([aPull({ test: [pkg(forced('outside every package', 'a.mjs'))], e2e: [e2eTier(forced('outside every package', 'a.mjs'))] })]);
      expect(html).toContain('narrow the rule for files no test can depend on');
      expect(html).toContain('A workflow, the lockfile or a root config forces every walk, and should.');
    });

    it('says plainly that it has no advice for a rule it does not know, and borrows none', () => {
      const html = render(forcedBy('a rule added next month', 'scripts/new.mjs'));
      const row = ruleRow(html, 'a rule added next month');
      expect(row).toContain('<span class="advice">No advice is written for this rule yet.</span>');
      expect(row).not.toContain('Expected; nothing to fix');
      expect(row).not.toContain('Fix:');
    });

    it('a rule caused by an event rather than a file has no paths to fold', () => {
      const html = render(forcedBy('push to main', null));
      expect(ruleRow(html, 'push to main')).toContain('push to main');
      expect(html).not.toContain('paths, worst first');
    });

    it('says so when nothing forced a full run', () => {
      expect(render(quietWindow())).toContain('Nothing forced a full run in this period.');
    });
  });
});
