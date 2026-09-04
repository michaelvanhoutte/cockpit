//
// Unit tests for the decisions scripts/e2e-stack.mjs makes before it starts
// anything. Run by `node --test` from the Scripts CI job.
//
// waitForApi takes its fetch, its clock and its timeout as options precisely so
// these can prove which branch it takes without a Worker and without waiting a
// minute for the timeout case.
//

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  assertPortFree,
  exitReport,
  fatalReason,
  newestLog,
  schemaDigest,
  templateIsCurrent,
  waitForApi,
} from './stack.mjs';

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

/**
 * Wrangler's log is a sequence of records, each headed by a timestamp and a
 * level and closed by a line of three dashes. The excerpts below are that
 * shape, taken from the two E2E jobs that died on 3 September 2026 and from a
 * Windows run that failed to start, because inventing the shape is exactly how
 * a reader of logs comes to be tested against logs nobody writes.
 */
const record = (level, body) => `--- 2026-09-03T02:23:54.633Z ${level}\n${body}\n---\n\n`;

/** What every failing `wrangler dev` prints last, and nothing else does. */
const ENDED_BADLY = record(
  'log',
  'If you think this is a bug then please create an issue at https://github.com/cloudflare/workers-sdk/issues/new/choose',
);

/** The ordinary noise: one per closed tab, twenty-five in a passing run. */
const STREAM_ERRORS = record('error', 'X [ERROR] Uncaught Error: Network connection lost. ').repeat(25);

/** The crash itself — an empty printed error, and the reason only in a cause. */
const PROXY_WORKER_FATAL =
  record(
    'debug',
    `Error in ProxyController: Error inside ProxyWorker
 Error
    at castErrorCause (/home/runner/work/cockpit/cockpit/node_modules/wrangler/wrangler-dist/cli.js:165148:19) {
  cause: {
    name: 'Error',
    message: 'Network connection lost.',
    stack: 'Error: Network connection lost.'
  }
}`,
  ) + record('error', '\u2718 [ERROR] ');

describe('fatalReason', () => {
  it('names the source and the cause when a controller reported the failure', () => {
    assert.equal(
      fatalReason(STREAM_ERRORS + PROXY_WORKER_FATAL + ENDED_BADLY),
      'Error inside ProxyWorker: Network connection lost.',
      'the printed error is empty, so this sentence exists nowhere else',
    );
  });

  it('takes the message Wrangler managed to print when there is no cause to read', () => {
    assert.equal(
      fatalReason(record('error', 'X [ERROR] spawn UNKNOWN') + ENDED_BADLY),
      'spawn UNKNOWN',
      'the cross is a plain X on Windows and a mark on a terminal that can draw one',
    );
  });

  it('reports no reason for a run whose only errors were closed tabs', () => {
    assert.equal(
      fatalReason(STREAM_ERRORS),
      null,
      'reporting the last stream error would name a browser navigation as the cause of death',
    );
  });

  it('ignores the stream errors above the fatal rather than preferring the last one', () => {
    assert.equal(
      fatalReason(STREAM_ERRORS + record('error', 'X [ERROR] spawn UNKNOWN') + ENDED_BADLY),
      'spawn UNKNOWN',
    );
  });

  it('says nothing rather than reaching past an empty fatal into the stream errors', () => {
    // The case the one above cannot see, because there the fatal is the last
    // line either way. This crash prints its error *empty*, so an
    // implementation that skips empties to find something to say reaches back
    // into the twenty-five closed tabs above and names one of them as the
    // cause of death — which is what this did until the review caught it.
    assert.equal(
      fatalReason(STREAM_ERRORS + record('error', '✘ [ERROR] ') + ENDED_BADLY),
      null,
      'an empty last error means Wrangler recorded no reason, not that an older line is the reason',
    );
  });

  it('reports no reason for a log that holds nothing at all', () => {
    assert.equal(fatalReason(''), null);
  });

  it('does not go looking for a cause outside the record that named the failure', () => {
    // The record after a fatal is `=> Error contextual data`, about a megabyte
    // of bundled configuration and library source with `message:` in it more
    // than once. A fatal with no cause of its own must not be answered with a
    // line from that.
    const noCause =
      record('debug', 'Error in ProxyController: Failed to start ProxyWorker') +
      record('debug', "=> Error contextual data: {\n  bundle: { message: 'not the reason at all' }\n}");
    assert.equal(fatalReason(noCause + ENDED_BADLY), 'Failed to start ProxyWorker');
  });
});

describe('newestLog', () => {
  /** A logs-e2e-shaped directory, with each file's age set explicitly. */
  function fakeLogDir(files) {
    const dir = mkdtempSync(join(tmpdir(), 'cockpit-logs-test-'));
    for (const [name, ageInSeconds] of Object.entries(files)) {
      const path = join(dir, name);
      writeFileSync(path, 'x');
      const when = new Date(Date.now() - ageInSeconds * 1000);
      utimesSync(path, when, when);
    }
    return dir;
  }

  it('is null when Wrangler wrote no log', () => {
    assert.equal(newestLog(fakeLogDir({})), null);
  });

  it('is null when the directory does not exist', () => {
    assert.equal(newestLog(join(tmpdir(), 'cockpit-logs-that-are-not-there')), null);
  });

  it('is the newest of several, which is this run rather than the last one', () => {
    const dir = fakeLogDir({ 'wrangler-old.log': 600, 'wrangler-new.log': 1, 'wrangler-older.log': 6000 });
    assert.equal(newestLog(dir), join(dir, 'wrangler-new.log'));
  });

  it('ignores files that are not logs', () => {
    const dir = fakeLogDir({ 'wrangler-old.log': 600, 'notes.txt': 1 });
    assert.equal(newestLog(dir), join(dir, 'wrangler-old.log'));
  });

  it('ignores a log from before this run started', () => {
    // The case that matters is a Worker that died before writing anything of
    // its own — a failed spawn. Without this, the last run's crash would be
    // read out as the reason for this one's.
    const dir = fakeLogDir({ 'wrangler-last-run.log': 600 });
    assert.equal(newestLog(dir, Date.now() - 60_000), null);
    assert.equal(newestLog(dir, Date.now() - 3_600_000), join(dir, 'wrangler-last-run.log'));
  });
});

describe('exitReport', () => {
  it('gives the reason and the log to read when the log explains the death', () => {
    const report = exitReport('test API', 1, '/logs/wrangler.log', PROXY_WORKER_FATAL + ENDED_BADLY);
    assert.match(report, /the test API exited \(1\): Error inside ProxyWorker: Network connection lost\./);
    assert.match(report, /\/logs\/wrangler\.log/);
  });

  it('says the log explains nothing rather than inventing a reason', () => {
    assert.match(
      exitReport('test API', 1, '/logs/wrangler.log', STREAM_ERRORS),
      /records no reason: \/logs\/wrangler\.log/,
    );
  });

  it('still names what died and with what code when there is no log at all', () => {
    assert.equal(
      exitReport('test web server', 1, null, null),
      'the test web server exited (1), leaving no log to say why',
      'Vite writes none, so this is the ordinary case rather than an error',
    );
  });
});
