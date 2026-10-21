import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { baseFromCheckoutLog, gainedPaths, inMergedTree, recheck } from './merge-recheck.mjs';

const HEAD = 'h'.repeat(40);
const BASE = 'b'.repeat(40);
const TIP = 't'.repeat(40);
const PACKAGES = [
  { name: '@cockpit/api', dir: 'apps/api' },
  { name: '@cockpit/web', dir: 'apps/web' },
  { name: '@cockpit/shared', dir: 'packages/shared' },
];

/** An `io` whose every edge is a plain value; `gained` is what main added, `outcome` what a check returns. */
function io({ base = BASE, tip = TIP, gained = [], conflict = null, outcome = () => ({ ok: true }) } = {}) {
  const ran = [];
  return {
    ran,
    head: () => HEAD,
    testedBase: async () => base,
    tip: () => tip,
    gained: () => gained,
    packages: () => PACKAGES,
    inMergedTree: async (work) => (conflict ? { conflict } : { result: await work('/merged') }),
    run: async (check) => {
      ran.push(check);
      return outcome(check);
    },
  };
}

const kinds = (ran) => ran.map((c) => (c.kind === 'suite' ? c.pkg : c.kind));

describe('a pull request is re-checked exactly when main has gained commits since the base its last CI run tested', () => {
  it('merges with no re-check when main is unchanged since the tested base', async () => {
    const edge = io({ tip: BASE, gained: ['apps/web/src/a.ts'] });
    const result = await recheck(edge);
    assert.equal(result.pass, true);
    assert.deepEqual(edge.ran, []);
  });

  it('re-checks when main gained commits touching product code', async () => {
    const edge = io({ gained: ['apps/web/src/a.ts'] });
    assert.equal((await recheck(edge)).pass, true);
    assert.notDeepEqual(edge.ran, []);
  });

  it('merges with no re-check when main gained only documentation', async () => {
    const edge = io({ gained: ['docs/architecture.md', 'readme.md'] });
    const result = await recheck(edge);
    assert.equal(result.pass, true);
    assert.deepEqual(edge.ran, []);
  });

  it('merges with no re-check when the branch was pushed again after merging current main and CI ran on it', async () => {
    // CI's checkout log names current main as the base, so nothing is gained.
    const edge = io({ base: TIP, tip: TIP, gained: ['apps/web/src/a.ts'] });
    const result = await recheck(edge);
    assert.equal(result.pass, true);
    assert.deepEqual(edge.ran, []);
  });

  it('is refused, saying so, when no CI run is found for the pull request head', async () => {
    const edge = { ...io(), testedBase: async () => null };
    const result = await recheck(edge);
    assert.equal(result.pass, false);
    assert.equal(result.noRun, true);
    assert.match(result.message, /no CI run found/);
  });
});

describe('what runs is what main gained, as local-changes selects it, plus typecheck and the bundle gate whenever product code is among it; never E2E', () => {
  it('runs typecheck, the bundle gate and the web suite when main gained a web change', async () => {
    const edge = io({ gained: ['apps/web/src/a.ts'] });
    await recheck(edge);
    assert.deepEqual(kinds(edge.ran).slice(0, 2), ['typecheck', 'bundle']);
    assert.ok(kinds(edge.ran).includes('@cockpit/web'));
  });

  it('runs typecheck, the bundle gate and the API suite when main gained an API change only, the gate being cheap enough to run always', async () => {
    const edge = io({ gained: ['apps/api/src/a.ts'] });
    await recheck(edge);
    assert.ok(kinds(edge.ran).includes('typecheck'));
    assert.ok(kinds(edge.ran).includes('@cockpit/api'));
    assert.ok(kinds(edge.ran).includes('bundle'));
  });

  it('selects no E2E for any selection', async () => {
      for (const gained of [['apps/web/src/a.ts'], ['apps/api/src/a.ts'], ['tests/e2e/a.test.ts'], ['pnpm-lock.yaml'], ['packages/shared/src/a.ts']]) {
        const edge = io({ gained });
        await recheck(edge);
        for (const check of edge.ran) {
          assert.ok(['typecheck', 'bundle', 'suite'].includes(check.kind));
          if (check.kind === 'suite') assert.ok(PACKAGES.some((p) => p.name === check.pkg), 'a workspace package, never the browser tier');
        }
      }
    });
});

describe('a passing re-check lets the merge through; a failing one refuses it and names what failed', () => {
  it('lets the merge through when every check passes', async () => {
    const result = await recheck(io({ gained: ['apps/web/src/a.ts'] }));
    assert.equal(result.pass, true);
  });

  it('refuses, naming typecheck, when typecheck fails', async () => {
    const result = await recheck(io({ gained: ['apps/api/src/a.ts'], outcome: (c) => ({ ok: c.kind !== 'typecheck' }) }));
    assert.equal(result.pass, false);
    assert.match(result.message, /typecheck failed/);
  });

  it('refuses, naming the bundle gate and the size, when the bundle is over the gate', async () => {
    const result = await recheck(
      io({
        gained: ['apps/web/src/a.ts'],
        outcome: (c) => (c.kind === 'bundle' ? { ok: false, output: 'Initial bundle, compressed: 512.3KB of 500KB\n  index.js' } : { ok: true }),
      }),
    );
    assert.equal(result.pass, false);
    assert.match(result.message, /bundle gate/);
    assert.match(result.message, /512\.3KB of 500KB/);
  });

  it('refuses, naming the package, when a selected suite fails', async () => {
    const result = await recheck(io({ gained: ['apps/web/src/a.ts'], outcome: (c) => ({ ok: c.pkg !== '@cockpit/web' }) }));
    assert.equal(result.pass, false);
    assert.match(result.message, /@cockpit\/web suite failed/);
    assert.doesNotMatch(result.message, /@cockpit\/api/);
  });

  it('refuses, naming the conflict, when the branch does not merge cleanly with current main', async () => {
    const edge = io({ gained: ['apps/web/src/a.ts'], conflict: ['apps/web/src/a.ts'] });
    const result = await recheck(edge);
    assert.equal(result.pass, false);
    assert.match(result.message, /does not merge cleanly/);
    assert.match(result.message, /apps\/web\/src\/a\.ts/);
    assert.deepEqual(edge.ran, []);
  });
});

describe('the base CI tested is read from its checkout log', () => {
  it('finds the main tip the head was merged into', () => {
    const log = `HEAD is now at 9889e9a1 Merge ${HEAD} into ${BASE}`;
    assert.equal(baseFromCheckoutLog(log, HEAD), BASE);
    assert.equal(baseFromCheckoutLog('nothing here', HEAD), null);
  });
});

// ---- Rule 4: a real repository ----

const run = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();

/** A repository whose `feature` branch and `main` have each added a different file, plus a `clash` branch editing the file `main` also edited. */
function fixture() {
  const repo = mkdtempSync(join(tmpdir(), 'recheck-test-'));
  run(repo, 'init', '-q', '-b', 'main');
  run(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'shared.txt'), 'one\n');
  run(repo, 'add', '.');
  run(repo, 'commit', '-qm', 'start');
  run(repo, 'checkout', '-qb', 'feature');
  writeFileSync(join(repo, 'feature.txt'), 'f\n');
  run(repo, 'add', '.');
  run(repo, 'commit', '-qm', 'feature');
  run(repo, 'checkout', '-qb', 'clash', 'main');
  writeFileSync(join(repo, 'shared.txt'), 'clash\n');
  run(repo, 'commit', '-qam', 'clash');
  run(repo, 'checkout', '-q', 'main');
  writeFileSync(join(repo, 'shared.txt'), 'main\n');
  writeFileSync(join(repo, 'main.txt'), 'm\n');
  run(repo, 'add', '.');
  run(repo, 'commit', '-qm', 'main moves');
  run(repo, 'checkout', '-q', 'feature');
  return { repo, dir: (name) => join(repo, '..', `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`) };
}

/** Everything a re-check must leave alone. */
function snapshot(repo) {
  return {
    branch: run(repo, 'rev-parse', '--abbrev-ref', 'HEAD'),
    heads: run(repo, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'),
    status: run(repo, 'status', '--porcelain'),
    files: ['shared.txt', 'feature.txt'].map((f) => (existsSync(join(repo, f)) ? readFileSync(join(repo, f), 'utf8') : null)),
    merging: existsSync(join(repo, '.git', 'MERGE_HEAD')),
  };
}

describe('the re-check leaves the branch and the working tree exactly as it found them, never committing or pushing the merge', () => {
  it('leaves them unchanged after a pass', async () => {
    const { repo, dir } = fixture();
    const before = snapshot(repo);
    const outcome = await inMergedTree({
      repo,
      dir: dir('pass'),
      head: run(repo, 'rev-parse', 'feature'),
      tip: run(repo, 'rev-parse', 'main'),
      work: async (d) => existsSync(join(d, 'main.txt')) && existsSync(join(d, 'feature.txt')),
    });
    assert.equal(outcome.result, true, 'the work saw both sides merged');
    assert.deepEqual(snapshot(repo), before);
    rmSync(repo, { recursive: true, force: true });
  });

  it('leaves them unchanged after a failure', async () => {
    const { repo, dir } = fixture();
    const before = snapshot(repo);
    const where = dir('fail');
    await assert.rejects(
      inMergedTree({ repo, dir: where, head: run(repo, 'rev-parse', 'feature'), tip: run(repo, 'rev-parse', 'main'), work: async () => { throw new Error('suite blew up'); } }),
      /suite blew up/,
    );
    assert.deepEqual(snapshot(repo), before);
    assert.equal(existsSync(where), false);
    assert.doesNotMatch(run(repo, 'worktree', 'list'), /fail-/);
    rmSync(repo, { recursive: true, force: true });
  });

  it('leaves them unchanged after a conflict, with no merge in progress', async () => {
    const { repo, dir } = fixture();
    const before = snapshot(repo);
    const where = dir('conflict');
    const outcome = await inMergedTree({ repo, dir: where, head: run(repo, 'rev-parse', 'clash'), tip: run(repo, 'rev-parse', 'main'), work: async () => 'never' });
    assert.deepEqual(outcome, { conflict: ['shared.txt'] });
    assert.deepEqual(snapshot(repo), before);
    assert.equal(snapshot(repo).merging, false);
    assert.equal(existsSync(where), false);
    rmSync(repo, { recursive: true, force: true });
  });

  it('starts clean and gives the same answer when run again after being stopped halfway', async () => {
    const { repo, dir } = fixture();
    const where = dir('halfway');
    const head = run(repo, 'rev-parse', 'feature');
    const tip = run(repo, 'rev-parse', 'main');
    // What a killed run leaves: a registered worktree holding an unfinished merge and a stray file.
    run(repo, 'worktree', 'add', '--detach', where, head);
    writeFileSync(join(where, 'stray.txt'), 'left over\n');
    execFileSync('git', ['merge', '--no-commit', '--no-ff', tip], { cwd: where, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    const work = async (d) => ({ stray: existsSync(join(d, 'stray.txt')), merged: existsSync(join(d, 'main.txt')) });
    const first = await inMergedTree({ repo, dir: where, head, tip, work });
    const second = await inMergedTree({ repo, dir: where, head, tip, work });
    assert.deepEqual(first, { result: { stray: false, merged: true } });
    assert.deepEqual(second, first);
    assert.equal(existsSync(where), false);
  });

  it('shows two re-checks of different pull requests at once only their own merged tree', async () => {
    const { repo, dir } = fixture();
    const tip = run(repo, 'rev-parse', 'main');
    const seenBy = (name, head) =>
      inMergedTree({
        repo,
        dir: dir(name),
        head,
        tip,
        // Held open together: each waits for the other to be inside its own merge before looking.
        work: async (d) => {
          await barrier();
          return { feature: existsSync(join(d, 'feature.txt')), shared: readFileSync(join(d, 'shared.txt'), 'utf8') };
        },
      });
    let waiting = 0;
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const barrier = () => {
      waiting += 1;
      if (waiting === 2) release();
      return gate;
    };
    const [a, b] = await Promise.all([seenBy('a', run(repo, 'rev-parse', 'feature')), seenBy('b', run(repo, 'rev-parse', 'main'))]);
    assert.deepEqual(a.result, { feature: true, shared: 'main\n' });
    assert.deepEqual(b.result, { feature: false, shared: 'main\n' });
    rmSync(repo, { recursive: true, force: true });
  });

  it('counts as gained only what the branch does not already contain', () => {
    const { repo } = fixture();
    const feature = run(repo, 'rev-parse', 'feature');
    const base = run(repo, 'merge-base', 'feature', 'main');
    const tip = run(repo, 'rev-parse', 'main');
    assert.deepEqual(gainedPaths(repo, base, feature, tip).sort(), ['main.txt', 'shared.txt']);
    run(repo, 'merge', '-q', '--no-edit', 'main');
    assert.deepEqual(gainedPaths(repo, base, run(repo, 'rev-parse', 'HEAD'), tip), []);
    rmSync(repo, { recursive: true, force: true });
  });
});
