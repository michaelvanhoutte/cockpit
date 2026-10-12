import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describeAnswer, planRun, unreachable } from './harness-run.mjs';

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

  describe('a run that outlasts the wait is not reported as unreachable', () => {
    it('a timeout says the job may still be running and to check the page', () => {
      const line = unreachable(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));

      assert.match(line, /may still be running/);
      assert.match(line, /costs page/);
    });

    it('any other failure says the monitor could not be reached', () => {
      assert.equal(unreachable(new TypeError('fetch failed')), 'Could not reach the monitor: fetch failed');
    });
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
      { situation: 'no job named', args: [], set: {}, error: 'Name the job to start: linking, prices, rebuild; linking --full re-reads from the first pull request.' },
      { situation: 'an unknown job', args: ['everything'], set: {}, error: 'Name the job to start: linking, prices, rebuild; linking --full' },
    ]) {
      it(`${situation} says what is missing and runs nothing`, () => {
        const plan = planRun(args, { ...env, ...set });

        assert.ok(plan.error.startsWith(error), plan.error);
        assert.equal(plan.url, undefined);
      });
    }
  });

  describe('a full re-read goes with linking alone', () => {
    it('linking --full is planned against the job address asking to start from the first pull request', () => {
      assert.equal(planRun(['linking', '--full'], env).url.href, 'https://monitor.example/v1/jobs/linking?full=1');
      assert.equal(planRun(['--full', 'linking'], env).url.href, 'https://monitor.example/v1/jobs/linking?full=1');
    });

    for (const { situation, args, error } of [
      { situation: '--full with prices', args: ['prices', '--full'], error: '--full re-reads pull requests from the start, so it goes only with linking.' },
      { situation: 'anything else after the job', args: ['linking', '--fulll'], error: 'Unexpected --fulll' },
    ]) {
      it(`${situation} is refused and runs nothing`, () => {
        const plan = planRun(args, env);

        assert.ok(plan.error.startsWith(error), plan.error);
        assert.equal(plan.url, undefined);
      });
    }
  });
});
