//
// Unit tests for the decisions scripts/e2e-stack.mjs makes before it starts
// anything. Run by `node --test` from the Scripts CI job.
//
// waitForApi takes its fetch, its clock and its timeout as options precisely so
// these can prove which branch it takes without a Worker and without waiting a
// minute for the timeout case.
//

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { assertPortFree, schemaDigest, templateIsCurrent, waitForApi } from './stack.mjs';

/** An apps/api-shaped directory with the two things the digest reads. */
function fakeApiDir({ migrations = { '0000_first.sql': 'create table a;' }, seed = 'insert into a;' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-stack-test-'));
  mkdirSync(join(dir, 'migrations'));
  for (const [name, sql] of Object.entries(migrations)) writeFileSync(join(dir, 'migrations', name), sql);
  writeFileSync(join(dir, 'seed.sql'), seed);
  return dir;
}

const ok = (body) => ({ ok: true, json: async () => body });

describe('schemaDigest', () => {
  it('is the same for the same schema and seed', () => {
    assert.equal(schemaDigest(fakeApiDir()), schemaDigest(fakeApiDir()));
  });

  it('changes when a migration changes', () => {
    const before = schemaDigest(fakeApiDir());
    const after = schemaDigest(fakeApiDir({ migrations: { '0000_first.sql': 'create table b;' } }));
    assert.notEqual(before, after, 'a template built against a schema that has changed is the failure to avoid');
  });

  it('changes when a migration is added', () => {
    const before = schemaDigest(fakeApiDir());
    const after = schemaDigest(
      fakeApiDir({ migrations: { '0000_first.sql': 'create table a;', '0001_second.sql': 'alter table a;' } }),
    );
    assert.notEqual(before, after);
  });

  it('changes when only the seed changes', () => {
    const before = schemaDigest(fakeApiDir());
    const after = schemaDigest(fakeApiDir({ seed: 'insert into a values (1);' }));
    assert.notEqual(before, after, 'the seed decides what a run starts from, so it is part of the template');
  });

  it('ignores files that are not migrations', () => {
    const plain = schemaDigest(fakeApiDir());
    const withNoise = schemaDigest(
      fakeApiDir({ migrations: { '0000_first.sql': 'create table a;', 'meta.json': '{}' } }),
    );
    assert.equal(plain, withNoise);
  });
});

describe('templateIsCurrent', () => {
  it('is false when no stamp exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cockpit-stamp-test-'));
    assert.equal(templateIsCurrent(join(dir, 'missing'), 'abc'), false);
  });

  it('is false when the stamp is for another schema', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cockpit-stamp-test-'));
    const stamp = join(dir, 'stamp');
    writeFileSync(stamp, 'aaa\n');
    assert.equal(templateIsCurrent(stamp, 'bbb'), false);
  });

  it('is true when the stamp matches, trailing newline and all', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cockpit-stamp-test-'));
    const stamp = join(dir, 'stamp');
    writeFileSync(stamp, 'abc\n');
    assert.equal(templateIsCurrent(stamp, 'abc'), true);
  });
});

describe('assertPortFree', () => {
  it('resolves when nothing is listening', async () => {
    await assertPortFree(0, 'test API', () => 'do something about it');
  });

  it('rejects when something is listening, saying what to do about it', async () => {
    const held = createServer();
    await new Promise((resolve) => held.listen(0, '127.0.0.1', resolve));
    const { port } = held.address();

    await assert.rejects(
      () => assertPortFree(port, 'test API', () => 'stop it, or use another port'),
      (error) => {
        assert.match(error.message, /already in use/);
        // The advice comes from the caller: what to do about a taken port is
        // different for the suite and for `pnpm dev`, and this check knows
        // about neither.
        assert.match(error.message, /stop it, or use another port/);
        return true;
      },
    );

    await new Promise((resolve) => held.close(resolve));
  });
});

describe('waitForApi', () => {
  const running = { exitCode: null, signalCode: null };

  it('returns once the Worker answers that its data is reachable', async () => {
    await waitForApi(running, 8887, {
      fetchImpl: async () => ok({ ok: true, register: true, store: true }),
      delayMs: 1,
    });
  });

  it('keeps waiting while the Worker is not listening yet', async () => {
    let attempts = 0;
    await waitForApi(running, 8887, {
      delayMs: 1,
      fetchImpl: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('ECONNREFUSED');
        return ok({ ok: true, register: true, store: true });
      },
    });
    assert.equal(attempts, 3, 'connection refused is the expected state for most of this loop');
  });

  it('keeps waiting while the Worker answers but its data is not reachable', async () => {
    // /health is 200 either way and reports reachability in its body, so a
    // status-only check would start the suite against a Worker whose register
    // or account store is not up — which is the slow part this wait exists for.
    let attempts = 0;
    await waitForApi(running, 8887, {
      delayMs: 1,
      fetchImpl: async () => {
        attempts += 1;
        return ok({ ok: attempts >= 2, register: attempts >= 2, store: attempts >= 2 });
      },
    });
    assert.equal(attempts, 2);
  });

  it('gives up when the Worker exited instead of coming up', async () => {
    const exited = { exitCode: 1, signalCode: null };
    await assert.rejects(
      () => waitForApi(exited, 8887, { fetchImpl: async () => ok({ ok: true }), delayMs: 1 }),
      /exited before it was ready \(1\)/,
    );
  });

  it('gives up when the Worker never answers', async () => {
    let clock = 0;
    await assert.rejects(
      () =>
        waitForApi(running, 8887, {
          delayMs: 1,
          timeoutMs: 10,
          now: () => (clock += 4),
          fetchImpl: async () => {
            throw new Error('ECONNREFUSED');
          },
        }),
      /never answered on :8887/,
    );
  });
});
