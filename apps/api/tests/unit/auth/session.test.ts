import { describe, expect, it } from 'vitest';
import {
  SIGN_IN_LIFETIME_MS,
  recogniseSession,
  type StoredSession,
} from '../../../src/auth/session.js';

/**
 * L1: whether a sign-in is still current is a comparison against a clock, and
 * the clock is handed in - so every branch is provable here, and the
 * alternative at any other level is a test that waits a month.
 *
 * What this cannot prove is that the rules are on the request path at all.
 * That is one case in tests/integration/http/sign-in.test.ts, which carries an
 * ended sign-in to a real endpoint and is refused; it deliberately does not
 * re-prove the branching below.
 */

const NOW = new Date('2026-09-01T12:00:00.000Z');

function held(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    id: 'a-sign-in',
    userId: 'user-michael',
    expiresAt: new Date(NOW.getTime() + SIGN_IN_LIFETIME_MS).toISOString(),
    ...overrides,
  };
}

describe('Sign-in', () => {
  describe('a sign-in lasts a set time and renews while you use it', () => {
    it('is recognised while it is still within its time', () => {
      expect(recogniseSession(held(), NOW)).toMatchObject({
        recognised: true,
        userId: 'user-michael',
      });
    });

    it.each([
      {
        situation: 'it ran out a moment ago',
        stored: held({ expiresAt: new Date(NOW.getTime() - 1).toISOString() }),
      },
      {
        // The boundary belongs to the past: a sign-in whose end is exactly now
        // has ended.
        situation: 'it ends at this very moment',
        stored: held({ expiresAt: NOW.toISOString() }),
      },
      { situation: 'nothing of it was ever held', stored: null },
    ])('is not recognised when $situation', ({ stored }) => {
      expect(recogniseSession(stored, NOW)).toEqual({ recognised: false });
    });

    it('ends a whole lifetime later every time it is used', () => {
      // Most of the way through, so the answer is plainly the renewal rather
      // than the stored value handed back.
      const nearlyOver = held({
        expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
      });

      const verdict = recogniseSession(nearlyOver, NOW);

      expect(verdict).toMatchObject({
        recognised: true,
        expiresAt: new Date(NOW.getTime() + SIGN_IN_LIFETIME_MS).toISOString(),
      });
    });
  });
});
