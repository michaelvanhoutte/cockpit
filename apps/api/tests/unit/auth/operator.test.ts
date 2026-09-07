import { describe, expect, it } from 'vitest';
import { isOperatorPath, secretAccepted } from '../../../src/auth/operator.js';

/**
 * Unit level, because deciding whether a request carries the secret is a
 * decision about two strings and nothing else - no store, no register, no
 * request. It is split out of the middleware precisely so the state that
 * matters most can be asked at all: an environment where the secret was never
 * put in, which the integration tier cannot express because its bindings always
 * have one.
 */

describe('Backup', () => {
  describe('backing up is refused to anyone without the operator’s secret', () => {
    const secret = 'the-operator-secret';

    it.each([
      { situation: 'the right secret', offered: `Bearer ${secret}`, allowed: true },
      { situation: 'a secret that is not the one set', offered: 'Bearer wrong', allowed: false },
      { situation: 'nothing at all', offered: undefined, allowed: false },
      { situation: 'an empty offer', offered: '', allowed: false },
      { situation: 'the secret without the scheme in front of it', offered: secret, allowed: false },
      { situation: 'the scheme with nothing after it', offered: 'Bearer', allowed: false },
      { situation: 'the scheme and only spaces after it', offered: 'Bearer    ', allowed: false },
      // Schemes are case-insensitive in the specification, so a client that
      // writes it the other way is not making a mistake.
      { situation: 'the scheme in other letters', offered: `bearer ${secret}`, allowed: true },
      { situation: 'somebody else’s scheme', offered: `Basic ${secret}`, allowed: false },
    ])('$situation', ({ offered, allowed }) => {
      expect(secretAccepted(offered, secret)).toBe(allowed);
    });

    /**
     * The case the whole split exists for. A new environment has no secret in
     * it until somebody runs `wrangler secret put`, and the two ways that can
     * go are opposites: shut until it is set, or open until it is set. Nothing
     * in an integration test can ask this, because its bindings always carry
     * one.
     */
    it.each([
      { situation: 'the right secret for another environment', offered: `Bearer ${secret}` },
      { situation: 'no secret', offered: undefined },
      { situation: 'any secret at all', offered: 'Bearer anything' },
    ])('an environment with no secret set refuses $situation', ({ offered }) => {
      expect(secretAccepted(offered, undefined)).toBe(false);
      expect(secretAccepted(offered, '')).toBe(false);
    });
  });

  describe('the operator’s routes are the only ones behind the secret', () => {
    it.each([
      { situation: 'backing up the register', path: '/v1/operator/backup/register', behind: true },
      { situation: 'backing up an account', path: '/v1/operator/backup/accounts/x', behind: true },
      { situation: 'the workspaces a person reads', path: '/v1/workspaces', behind: false },
      { situation: 'the health check', path: '/health', behind: false },
      { situation: 'signing in', path: '/v1/sign-in', behind: false },
      // Exactly the trap `PATHS_OUTSIDE_THE_GATE` records for `/v1/users`: a
      // prefix that stops one character early is a hole nobody chose. This one
      // matters in the opposite direction - a path that merely starts the same
      // way must not be let past the sign-in gate as though it were behind the
      // secret.
      { situation: 'a path that only starts like one', path: '/v1/operators', behind: false },
      // The address the operator's routes used to hold, and the one the admin
      // pages are going to. Neither is behind the secret: the first answers
      // that it moved, the second is behind a sign-in and a role like every
      // other page. A secret standing in front of either would refuse the
      // person it is meant for.
      { situation: 'where the operator’s routes used to be', path: '/v1/admin/backup/register', behind: false },
      { situation: 'the admin pages’ own address', path: '/v1/admin/users', behind: false },
    ])('$situation', ({ path, behind }) => {
      expect(isOperatorPath(path)).toBe(behind);
    });
  });
});
