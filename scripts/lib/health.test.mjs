//
// Unit tests for the post-deploy health assertion, run by `node --test` from
// the Scripts CI job, like the rest of scripts/lib.
//
// Nothing here reaches a deployment. What is worth asserting is the reading -
// which answers mean the deploy should stop, and which are worth asking again -
// because the previous version of this decision lived in bash and asked once,
// and the one thing it could not tell apart was a deployment that was broken
// from one that had not finished its first request yet.
//

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { checkUntilHealthy, failureReport, readAnswer, worthRetrying } from './health.mjs';

const healthy = JSON.stringify({ ok: true, register: true, store: true });
const unwell = JSON.stringify({ ok: false, register: true, store: false });

/** An `ask` that walks a fixed list of answers, then repeats the last one. */
function answering(...answers) {
  let i = 0;
  return async () => answers[Math.min(i++, answers.length - 1)];
}

/**
 * No real waiting, and no real clock either. The clock matters as much as the
 * sleep: left real, a case that stops retrying only because it should would sit
 * through the whole sixty-second window the day that stops being true, which
 * turns a regression into a hang rather than a failure.
 */
const fast = () => ({ delayMs: 0, sleep: async () => {}, now: tickingClock() });

function tickingClock(step = 1_000) {
  let at = 0;
  return () => (at += step);
}

describe('readAnswer', () => {
  // A loop rather than a table helper: node:test has no `it.each`, and the
  // other files in scripts/lib spell their cases out the same way.
  for (const { situation, status, body, state } of [
    { situation: 'a deployment that says it is well', status: 200, body: healthy, state: 'healthy' },
    { situation: 'a deployment that says it is not', status: 200, body: unwell, state: 'unhealthy' },
    { situation: 'a login page in front of the Worker', status: 200, body: '<html>Sign in', state: 'not-ours' },
    { situation: 'our JSON without the verdict in it', status: 200, body: '{"db":true}', state: 'not-ours' },
    { situation: 'the gate having swallowed /health', status: 302, body: '', state: 'gated' },
    { situation: 'a Worker that is up and failing', status: 500, body: 'boom', state: 'failing' },
    { situation: 'an edge that has not caught up yet', status: 503, body: '', state: 'failing' },
    { situation: 'being asked to slow down', status: 429, body: '', state: 'failing' },
    { situation: 'an address that is not ours', status: 404, body: 'nope', state: 'error' },
    { situation: 'nothing coming back at all', status: 0, body: '', state: 'unreachable' },
  ]) {
    it(`reads ${situation} as ${state}`, () => {
      assert.equal(readAnswer({ status, body }).state, state);
    });
  }

  it('names the Bypass policy when the gate has swallowed /health', () => {
    assert.match(readAnswer({ status: 302, body: '' }).message, /Bypass policy scoped to the \/health path/);
  });

  it('sends the reader to the logs, since the body never carries the reason', () => {
    assert.match(readAnswer({ status: 200, body: unwell }).message, /logs, never in this body/);
  });
});

describe('worthRetrying', () => {
  it('waits only on what settling could fix', () => {
    assert.deepEqual(
      ['healthy', 'unhealthy', 'unreachable', 'failing', 'gated', 'not-ours', 'error'].filter(worthRetrying),
      ['unhealthy', 'unreachable', 'failing'],
    );
  });
});

describe('failureReport', () => {
  const answer = { message: 'was unwell.' };

  it('says how long it waited, when waiting is what it did', () => {
    const line = failureReport({ stopped: 'window-closed', attempts: 12, answer }, 60_000, 3_000);
    assert.equal(line, 'was unwell. Still so after 12 attempts over 60s, asking every 3s.');
  });

  it('claims no waiting it did not do, when the last answer was one it would not wait on', () => {
    // Two attempts, because an earlier one was retryable - but the run ended on
    // an answer it refused to wait on, seconds in rather than a minute.
    assert.equal(failureReport({ stopped: 'not-worth-retrying', attempts: 2, answer }), 'was unwell.');
  });
});

describe('checkUntilHealthy', () => {
  it('passes on the first answer when the deployment is already well', async () => {
    const result = await checkUntilHealthy(answering({ status: 200, body: healthy }), fast());
    assert.equal(result.ok, true);
    assert.equal(result.attempts, 1);
  });

  it('passes when the first request after a deploy is the one doing the work', async () => {
    // The case this exists for: /health opens an account store, and the first
    // request after a deploy is the one that creates it and applies every
    // outstanding change. Observed on the deploy of a762ff1.
    const result = await checkUntilHealthy(
      answering({ status: 200, body: unwell }, { status: 200, body: healthy }),
      fast(),
    );
    assert.equal(result.ok, true);
    assert.equal(result.attempts, 2, 'the deploy log has to show it took two goes');
  });

  it('fails when the deployment is still unwell when the window closes', async () => {
    let clock = 0;
    const result = await checkUntilHealthy(answering({ status: 200, body: unwell }), {
      ...fast(),
      windowMs: 30,
      now: () => (clock += 10),
    });
    assert.equal(result.ok, false);
    assert.equal(result.answer.state, 'unhealthy');
    assert.equal(result.body, unwell, 'the last body is quoted, so the failure says what it saw');
  });

  it('gives a broken perimeter back at once rather than waiting on it', async () => {
    let asked = 0;
    const result = await checkUntilHealthy(
      async () => {
        asked += 1;
        return { status: 302, body: '' };
      },
      fast(),
    );
    assert.equal(result.ok, false);
    assert.equal(asked, 1, 'waiting cannot put a Bypass policy back');
  });

  it('reports every attempt, so a slow deployment does not read as an immediate one', async () => {
    const seen = [];
    await checkUntilHealthy(answering({ status: 0, body: '' }, { status: 200, body: healthy }), {
      ...fast(),
      onAttempt: ({ attempt, answer }) => seen.push(`${attempt}:${answer.state}`),
    });
    assert.deepEqual(seen, ['1:unreachable', '2:healthy']);
  });

  it('waits out an edge that has not caught up with the deploy yet', async () => {
    // curl --retry treated 429 and 5xx as transient, and the check this
    // replaced inherited that for free. Losing it would swap one
    // first-request-after-a-deploy race for another.
    const result = await checkUntilHealthy(
      answering({ status: 503, body: '' }, { status: 200, body: healthy }),
      fast(),
    );
    assert.equal(result.ok, true);
    assert.equal(result.attempts, 2);
  });

  it('says the window closed on it, not that it gave up', async () => {
    let clock = 0;
    const result = await checkUntilHealthy(answering({ status: 200, body: unwell }), {
      ...fast(),
      windowMs: 30,
      now: () => (clock += 10),
    });
    assert.equal(result.stopped, 'window-closed');
  });

  it('says it gave up, when the last answer was one waiting cannot fix', async () => {
    // A mix: unreachable first, so it does wait once, then a redirect, which it
    // will not wait on. Reporting "still so after 2 attempts over 60s" here
    // would claim both a persistence and a duration that never happened.
    const result = await checkUntilHealthy(
      answering({ status: 0, body: '' }, { status: 302, body: '' }),
      fast(),
    );
    assert.equal(result.stopped, 'not-worth-retrying');
    assert.equal(result.attempts, 2);
  });

  it('still gets one real answer when it starts with no window left', async () => {
    const result = await checkUntilHealthy(answering({ status: 200, body: healthy }), {
      ...fast(),
      windowMs: 0,
      now: () => 1_000,
    });
    assert.equal(result.ok, true);
  });
});
