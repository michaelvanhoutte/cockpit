import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describeAnswer, planRun } from './harness-run.mjs';

const env = { HARNESS_MONITOR_URL: 'https://monitor.example', HARNESS_WRITE_KEY: 'k' };

describe('Harness Monitor', () => {
  describe('the command prints the outcome', () => {
    it('a job that did its work is printed as a sentence and succeeds', () => {
      const answer = describeAnswer('linking', 200, { job: 'linking', ok: true, message: 'Linked 2 pull requests; caught up with GitHub.' });

      assert.deepEqual(answer, { ok: true, line: 'linking: done - Linked 2 pull requests; caught up with GitHub.' });
    });

    for (const { situation, status, body, line } of [
      { situation: 'a job that failed', status: 200, body: { ok: false, message: 'GitHub refused the token (401).' }, line: 'linking: failed - GitHub refused the token (401).' },
      { situation: 'a refused key', status: 401, body: { error: 'x' }, line: 'The monitor refused the write key.' },
      { situation: 'a Worker with no key', status: 503, body: { error: 'x' }, line: 'The monitor has no write key set, so it starts nothing.' },
      { situation: 'an answer that is not the monitor\'s', status: 502, body: null, line: 'The monitor answered 502.' },
    ]) {
      it(`${situation} fails the command with the reason`, () => {
        assert.deepEqual(describeAnswer('linking', status, body), { ok: false, line });
      });
    }
  });

  describe('the command needs a job and the monitor\'s address and key', () => {
    it('a job with both set is planned against the job address', () => {
      const plan = planRun(['rebuild'], env);

      assert.equal(plan.url.href, 'https://monitor.example/v1/jobs/rebuild');
      assert.equal(plan.key, 'k');
    });

    for (const { situation, args, set, error } of [
      { situation: 'no address', args: ['prices'], set: { HARNESS_MONITOR_URL: undefined }, error: 'Set HARNESS_MONITOR_URL first' },
      { situation: 'no key', args: ['prices'], set: { HARNESS_WRITE_KEY: '' }, error: 'Set HARNESS_WRITE_KEY first' },
      { situation: 'neither', args: ['prices'], set: { HARNESS_MONITOR_URL: undefined, HARNESS_WRITE_KEY: undefined }, error: 'Set HARNESS_MONITOR_URL and HARNESS_WRITE_KEY first' },
      { situation: 'no job named', args: [], set: {}, error: 'Name the job to start: linking, prices, rebuild.' },
      { situation: 'an unknown job', args: ['everything'], set: {}, error: 'Name the job to start: linking, prices, rebuild.' },
    ]) {
      it(`${situation} says what is missing and runs nothing`, () => {
        const plan = planRun(args, { ...env, ...set });

        assert.ok(plan.error.startsWith(error), plan.error);
        assert.equal(plan.url, undefined);
      });
    }
  });
});
