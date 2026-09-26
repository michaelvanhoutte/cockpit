import { describe, expect, it } from 'vitest';

import { buildModel } from '../../src/model.js';
import { renderHtml } from '../../src/render/html.js';

const NOW = new Date('2026-02-15T00:00:00Z');

const file = ({ path, level = 'unit', status = 'passed', selectedBy = null }) => ({ path, level, status, selectedBy });
const pkg = ({ name = '@cockpit/pkg', dir = 'apps/pkg', mode = 'changed', reason = null, report = 'written', files = [] }) => ({ name, dir, mode, reason, report, files });
const record = ({ event = 'pull_request', baseCommit = 'abc123', changedFiles = [], packages = [] }) => ({ event, baseCommit, changedFiles, packages });

let nextNumber = 1;
function pullData({ prRecord = null, mainRecord = null, files = null, mergedAt = NOW.toISOString(), title, ...rest } = {}) {
  const number = rest.number ?? nextNumber++;
  return {
    pull: { number, title: title ?? `Widen the thing (#${number})`, url: `https://github.com/o/r/pull/${number}`, mergedAt },
    prRun: prRecord ? { id: number * 10, testDurationMs: 60_000, record: prRecord } : null,
    mainRun: mainRecord ? { id: number * 10 + 1, testDurationMs: 400_000, record: mainRecord } : null,
    files,
  };
}

const render = (pulls) => renderHtml(buildModel({ pulls, now: NOW, requestedDays: 14, coveredSince: new Date('2026-02-01'), repo: 'o/r' }));

describe('renderHtml', () => {
  it('shows a miss in the misses table and in its pull request drill-down among the tests not run', () => {
    const html = render([
      pullData({
        prRecord: record({ packages: [pkg({ mode: 'changed', files: [file({ path: 'apps/pkg/tests/unit/a.test.ts', status: 'not run' })] })] }),
        mainRecord: record({ event: 'push', packages: [pkg({ mode: 'full', files: [file({ path: 'apps/pkg/tests/unit/a.test.ts', status: 'failed' })] })] }),
      }),
    ]);
    expect(html).toContain('apps/pkg/tests/unit/a.test.ts');
    expect(html).toContain('miss: failed on main');
    expect(html).toContain('1 miss');
  });

  it('shows "skipped: documentation only" for a documentation-only pull request, in place of any counts', () => {
    const html = render([pullData({ files: ['docs/notes.md'] })]);
    expect(html).toContain('Skipped: documentation only.');
    expect(html).toContain('docs only');
  });

  it('shows "no record" for a pull request whose Test job left no artifact', () => {
    const html = render([pullData({ files: ['apps/api/src/thing.ts'] })]);
    expect(html).toContain('No record');
  });

  it('says "none" rather than a zero for a window with nothing in it', () => {
    const html = render([]);
    expect(html).toContain('none');
  });

  it('names the rule and path that forced a full run, and the pull requests it forced', () => {
    const html = render([
      pullData({
        prRecord: record({ packages: [pkg({ mode: 'full', reason: { rule: 'outside every package', path: 'pnpm-lock.yaml' }, files: [] })] }),
      }),
    ]);
    expect(html).toContain('outside every package');
    expect(html).toContain('pnpm-lock.yaml');
  });

  it('names the most common chain beside a test selected most often', () => {
    const html = render([
      pullData({
        prRecord: record({ packages: [pkg({ mode: 'changed', files: [file({ path: 'apps/pkg/tests/unit/a.test.ts', status: 'passed', selectedBy: { kind: 'chain', chain: ['apps/pkg/tests/unit/a.test.ts', 'apps/pkg/src/x.ts'] } })] })] }),
      }),
    ]);
    expect(html).toContain('apps/pkg/tests/unit/a.test.ts → apps/pkg/src/x.ts');
  });

  it("does not repeat a ran file's own path as the first hop of its own chain", () => {
    const html = render([
      pullData({
        prRecord: record({
          packages: [pkg({ mode: 'changed', files: [file({ path: 'apps/pkg/tests/unit/a.test.ts', status: 'passed', selectedBy: { kind: 'chain', chain: ['apps/pkg/tests/unit/a.test.ts', 'apps/pkg/src/b.ts', 'apps/pkg/src/x.ts'] } })] })],
        }),
      }),
    ]);
    // The per-file line reads "<path> via <rest of the chain>", not the file's
    // own path restated as the chain's own first hop.
    expect(html).toMatch(/apps\/pkg\/tests\/unit\/a\.test\.ts(?!\s*→)[^<]*<span class="chain">via apps\/pkg\/src\/b\.ts → apps\/pkg\/src\/x\.ts<\/span>/);
  });

  it('links to the other three published reports', () => {
    const html = render([]);
    expect(html).toContain('Test explorer');
    expect(html).toContain('CI stability');
    expect(html).toContain('Lead time');
  });
});
