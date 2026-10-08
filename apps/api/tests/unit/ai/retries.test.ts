import Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLAUDE_RETRIES } from '../../../src/ai/index.js';

/**
 * Unit level: which failed attempts are worth a second, and after how long, is
 * a decision on the error alone, so each is built as the SDK throws it and the
 * clock is held still. That a real retry leaves a record per attempt is the
 * integration tier's (tests/integration/http/ai-usage.test.ts).
 */

const NOW = new Date('2026-10-08T12:00:00.000Z');

function answered(status: number, headers: Record<string, string> = {}): Error {
  return Anthropic.APIError.generate(status, { type: 'error', error: { type: 'x', message: 'x' } }, 'x', new Headers(headers));
}

/** The SDK's own first wait: half a second, with up to a quarter off. */
const ABOUT_HALF_A_SECOND = 'about half a second';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AI usage', () => {
  describe('a failed call is tried once more only where Claude says it is worth it, after the wait it asked for', () => {
    it.each([
      { situation: 'the connection failed', error: new Anthropic.APIConnectionError({ message: 'x' }), wait: ABOUT_HALF_A_SECOND, then: 'tries again after about half a second' },
      { situation: 'Claude did not answer in time', error: new Anthropic.APIConnectionTimeoutError(), wait: ABOUT_HALF_A_SECOND, then: 'tries again after about half a second' },
      { situation: 'Claude was rate-limited and asked for 2 seconds', error: answered(429, { 'retry-after': '2' }), wait: 2000, then: 'tries again after 2 seconds' },
      { situation: 'Claude was overloaded and asked for 1500 milliseconds', error: answered(529, { 'retry-after-ms': '1500' }), wait: 1500, then: 'tries again after 1.5 seconds' },
      {
        situation: 'Claude was unavailable and asked to wait until a time 20 seconds away',
        error: answered(503, { 'retry-after': new Date(NOW.getTime() + 20_000).toUTCString() }),
        wait: 20_000,
        then: 'tries again after 20 seconds',
      },
      { situation: 'Claude asked for longer than a minute', error: answered(429, { 'retry-after': '120' }), wait: ABOUT_HALF_A_SECOND, then: 'tries again after about half a second' },
      { situation: 'Claude was overloaded and asked for nothing', error: answered(529), wait: ABOUT_HALF_A_SECOND, then: 'tries again after about half a second' },
      { situation: 'Claude refused the request but said to try again', error: answered(400, { 'x-should-retry': 'true' }), wait: ABOUT_HALF_A_SECOND, then: 'tries again after about half a second' },
      { situation: 'Claude refused the request', error: answered(400), wait: null, then: 'does not try again' },
      { situation: 'Claude failed but said not to try again', error: answered(500, { 'x-should-retry': 'false' }), wait: null, then: 'does not try again' },
      { situation: 'the call was abandoned', error: new Anthropic.APIUserAbortError(), wait: null, then: 'does not try again' },
      { situation: 'something other than Claude failed', error: new Error('x'), wait: null, then: 'does not try again' },
    ])('$then when $situation', ({ error, wait }) => {
      const waited = CLAUDE_RETRIES.retryAfter(error, 1);

      if (wait === ABOUT_HALF_A_SECOND) {
        expect(waited).toBeGreaterThanOrEqual(375);
        expect(waited).toBeLessThanOrEqual(500);
      } else {
        expect(waited).toBe(wait);
      }
    });
  });

  describe('a failed attempt’s record says how it ended', () => {
    it.each([
      { situation: 'Claude did not answer in time', error: new Anthropic.APIConnectionTimeoutError(), ended: { outcome: 'timed-out' } },
      { situation: 'Claude was overloaded', error: answered(529), ended: { outcome: 'error', status: 529 } },
      { situation: 'the connection failed', error: new Anthropic.APIConnectionError({ message: 'x' }), ended: { outcome: 'error', status: null } },
      { situation: 'something other than Claude failed', error: new Error('x'), ended: { outcome: 'error', status: null } },
    ])('when $situation', ({ error, ended }) => {
      expect(CLAUDE_RETRIES.outcomeOf(error)).toEqual(ended);
    });
  });
});
