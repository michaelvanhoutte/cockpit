/**
 * pool()'s abort behaviour in isolation, with hand-controlled timing: the full
 * fetch-stub pipeline in tests/integration/github.test.js resolves everything
 * on the same microtask tick, so it cannot pin down whether a lane still
 * running when another one fails goes on to start further items.
 */

import { describe, expect, it } from 'vitest';

import { pool } from '../../src/github.js';

/** A promise this test resolves or rejects on its own schedule, not the runtime's. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('pool', () => {
  it('runs every item to completion when nothing sets abort', async () => {
    const seen = [];
    const results = await pool([1, 2, 3], 2, async (item) => {
      seen.push(item);
      return item * 10;
    });
    expect(results).toEqual([10, 20, 30]);
    expect(seen.sort()).toEqual([1, 2, 3]);
  });

  it('starts no further item once abort is set, even one already dispatched to another lane', async () => {
    const started = [];
    const abort = { stopped: false };
    const gates = { fails: deferred(), 'in-flight': deferred() };

    // Each worker is pushed to `started` the moment it is called — before it
    // awaits anything — the same as request()'s own `await fetchImpl(...)`:
    // both lanes' first calls go out before either settles, and only the one
    // named "fails" sets `abort` once its own gate lets it proceed.
    const worker = async (item) => {
      started.push(item);
      if (item === 'fails') {
        await gates.fails.promise;
        abort.stopped = true;
        throw new Error('boom');
      }
      if (item === 'in-flight') return gates['in-flight'].promise;
      return item;
    };

    const failure = expect(pool(['fails', 'in-flight', 'never', 'reached'], 2, worker, abort)).rejects.toThrow('boom');
    // A tick for both lanes to start and dispatch their first item, before
    // either gate opens — the concurrent burst a real failure cannot prevent.
    await Promise.resolve();
    expect(started).toEqual(['fails', 'in-flight']);

    gates.fails.resolve();
    await failure;

    // The lane stuck on "in-flight" has not been told to stop; only once it
    // resolves does its loop get a chance to check `abort` again.
    expect(started).toEqual(['fails', 'in-flight']);
    gates['in-flight'].resolve('done');
    // A macrotask boundary, so every microtask the resolved promise unlocks —
    // the lane's own continuation among them — has already run.
    await new Promise((resolve) => setImmediate(resolve));

    // It must not have gone on to pull "never" off the queue once it woke up.
    expect(started).toEqual(['fails', 'in-flight']);
  });
});
