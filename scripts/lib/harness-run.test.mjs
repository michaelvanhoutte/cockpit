import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describeAnswer, nextJob, planRun, unreachable } from './harness-run.mjs';

const env = { HARNESS_MONITOR_URL: 'https://monitor.example', HARNESS_WRITE_KEY: 'k' };

describe('Harness Monitor', () => {
  describe('the command prints the outcome', () => {
    it('a job that did its work is printed as a sentence and succeeds', () => {
      const answer = describeAnswer('linking', 200, { job: 'linking', ok: true, message: 'Linked 2 pull requests; caught up with GitHub.' });

      assert.deepEqual(answer, { ok: true, line: 'linking: done - Linked 2 pull requests; caught up with GitHub.', priced: 0 });
    });

    it('a prices answer carries the count it priced, and one without a count carries 0', () => {
      assert.equal(describeAnswer('prices', 200, { ok: true, message: 'm', priced: 20_000 }).priced, 20_000);
      assert.equal(describeAnswer('prices', 200, { ok: true, message: 'm' }).priced, 0);
    });

    for (const { situation, status, body, line } of [
      { situation: 'a job that failed', status: 200, body: { ok: false, message: 'GitHub refused the token (401).' }, line: 'linking: failed - GitHub refused the token (401).' },
      { situation: 'a refused key', status: 401, body: { error: 'x' }, line: 'The monitor refused the write key.' },
      { situation: 'a Worker with no key', status: 503, body: { error: 'x' }, line: 'The monitor has no write key set, so it starts nothing.' },
      { situation: 'an answer that is not the monitor\'s', status: 502, body: null, line: 'The monitor answered 502.' },
    ]) {
      it(`${situation} fails the command with the reason`, () => {
        assert.deepEqual(describeAnswer('linking', status, body), { ok: false, line, priced: 0 });
      });
    }
  });

  describe('prices is started again until a run prices nothing, then rebuild once', () => {
    /** Plays the command's loop over scripted answers, returning the jobs it started. */
    const play = (requested, answers) => {
      const started = [];
      let previous = null;
      for (let job = nextJob(requested, null); job; job = nextJob(requested, previous)) {
        started.push(job);
        previous = { job, ...answers[started.length - 1] };
      }
      return started;
    };
    const ok = (priced) => ({ ok: true, priced });

    for (const { situation, answers, started } of [
      { situation: 'runs price 20,000, then 5, then 0', answers: [ok(20_000), ok(5), ok(0), ok(0)], started: ['prices', 'prices', 'prices', 'rebuild'] },
      { situation: 'the first run prices 0', answers: [ok(0), ok(0)], started: ['prices', 'rebuild'] },
      { situation: 'an answer with no count (an older Worker)', answers: [{ ok: true }, ok(0)], started: ['prices', 'rebuild'] },
      { situation: 'the second prices run fails', answers: [ok(20_000), { ok: false, priced: 0 }], started: ['prices', 'prices'] },
      { situation: 'a prices run that failed after pricing some', answers: [{ ok: false, priced: 7 }], started: ['prices'] },
      { situation: 'the monitor is unreachable mid-loop', answers: [ok(5), { ok: false, priced: 0 }], started: ['prices', 'prices'] },
      { situation: 'rebuild fails after the loop', answers: [ok(0), { ok: false, priced: 0 }], started: ['prices', 'rebuild'] },
    ]) {
      it(`${situation} starts ${started.join(', ')}`, () => {
        assert.deepEqual(play('prices', answers), started);
      });
    }

    for (const job of ['linking', 'rebuild']) {
      it(`${job} started by hand runs once`, () => {
        assert.deepEqual(play(job, [ok(9), ok(9)]), [job]);
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
