//
// The clock rule at every tier (scripts/lib/clock-rule.mjs), from "Hold the
// clock rule at every tier, and list the slow tests" (issue 1425). The last
// test is the enforcement: it diffs this branch against the merge-base and
// refuses the clock reads it adds. The reads below are assembled from parts so
// this file adds none itself.
//

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { clockReport, findClockReads, renderClockReads } from './clock-rule.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

const NOW = ['Date', 'now()'].join('.');
const NEW_DATE = ['new', ' Date', '()'].join('');

/** Checks `file` whose whole current content is `lines`, with every line added. */
function check(file, lines) {
  const diff = `+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}\n`;
  return findClockReads(diff, () => lines.join('\n'));
}

describe('findClockReads', () => {
  it('refuses a Date.now() added in an integration test, naming file and line', () => {
    const found = check('apps/api/tests/integration/a.test.ts', ['const a = 1;', `const t = ${NOW};`]);
    assert.deepEqual(found.map(({ file, line }) => [file, line]), [['apps/api/tests/integration/a.test.ts', 2]]);
    assert.match(renderClockReads(found)[0], /^apps\/api\/tests\/integration\/a\.test\.ts:2 /);
  });

  it('refuses a new Date() with no argument', () => {
    assert.equal(check('apps/web/tests/unit/a.test.tsx', [`const d = ${NEW_DATE};`]).length, 1);
  });

  it('passes a new Date with an argument', () => {
    assert.deepEqual(check('apps/web/tests/unit/a.test.tsx', ["const d = new Date('2026-10-21');"]), []);
  });

  it('refuses a read added in a browser walk', () => {
    assert.equal(check('tests/e2e/inbox.test.ts', [`const t = ${NOW};`]).length, 1);
  });

  it('refuses a read added in a script’s node --test file', () => {
    assert.equal(check('scripts/lib/x.test.mjs', [`const t = ${NOW};`]).length, 1);
  });

  it('passes a read on an unchanged line of a touched file', () => {
    const diff = '+++ b/apps/api/tests/unit/a.test.ts\n@@ -1 +1 @@\n+const a = 2;\n';
    const source = `const a = 2;\nconst t = ${NOW};\n`;
    assert.deepEqual(findClockReads(diff, () => source), []);
  });

  it('passes a read in product source, which is not a test', () => {
    assert.deepEqual(check('apps/api/src/clock.ts', [`export const now = () => ${NOW};`]), []);
  });

  it('passes an added read marked in place with its reason', () => {
    assert.deepEqual(check('apps/api/tests/unit/a.test.ts', [`const t = ${NOW}; // clock-ok: measures real elapsed time`]), []);
  });

  it('refuses an added read marked with no reason', () => {
    const found = check('apps/api/tests/unit/a.test.ts', [`const t = ${NOW}; // clock-ok:`, `const u = ${NOW}; // clock-ok`]);
    assert.deepEqual(found.map(({ problem }) => problem), ['marker without a reason', 'marker without a reason']);
  });

  it('passes a read in a file that installs fake time', () => {
    for (const install of ['vi.useFakeTimers();', "vi.setSystemTime('2026-10-21');", "await page.clock.install({ time: 0 });"]) {
      assert.deepEqual(check('apps/api/tests/unit/a.test.ts', [install, `const t = ${NOW};`]), [], install);
    }
  });

  it('passes performance.now(), which measures elapsed time and never a date', () => {
    assert.deepEqual(check('apps/api/tests/unit/a.test.ts', ['const t = performance.now();']), []);
  });

  it('checks nothing, and says so, with no merge-base to diff against', () => {
    const report = clockReport(null, () => null);
    assert.equal(report.checked, false);
    assert.match(report.said, /no merge-base/);
  });
});

/** The unified-0 diff of this branch against the merge-base, working tree included, or null with none to diff against. */
function branchDiff() {
  for (const against of ['origin/main', 'main']) {
    const diff = spawnSync('git', ['diff', '--unified=0', '--merge-base', against], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (diff.status === 0) return diff.stdout;
  }
  return null;
}

/** A diff adding every line of each untracked file, which `git diff` cannot see. */
function untrackedDiff() {
  const listed = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' });
  if (listed.status !== 0) return '';
  return listed.stdout
    .split('\n')
    .filter(Boolean)
    .map((file) => {
      const count = readFile(file)?.split('\n').length ?? 0;
      return count ? `+++ b/${file}\n@@ -0,0 +1,${count} @@\n` : '';
    })
    .join('');
}

function readFile(file) {
  try {
    return readFileSync(join(root, file), 'utf8');
  } catch {
    return null;
  }
}

describe('the lines this branch adds', () => {
  it('read no real clock in a test', () => {
    const diff = branchDiff();
    if (diff === null) {
      console.log('  clock rule: no merge-base with main to diff against, so nothing was checked.');
      return;
    }
    const found = findClockReads(`${diff}\n${untrackedDiff()}`, readFile);
    assert.deepEqual(renderClockReads(found), [], 'a test added a real-clock read; inject time, or mark a deliberate read in place with a reason');
  });
});
