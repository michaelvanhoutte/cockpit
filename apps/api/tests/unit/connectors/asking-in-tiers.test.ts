import { describe, expect, it } from 'vitest';
import type { OAuthDescriptor } from '@cockpit/connector-sdk';
import { adminApprovalNeeded, firstTier, steppedDown, tierAsked } from '../../../src/connectors/sign-in.js';
import { newAttempt } from '../../../src/auth/oidc.js';

/**
 * L1: when a source's refusal is an administrator's approval being needed, and
 * which tier a sign-in asks next ("Read pasted Teams links: connecting Teams
 * asks for no read permission", issue 1754). The whole of it is pure, so every
 * branch is proven here; that the routes act on it is
 * tests/integration/connectors/connecting-teams-in-tiers.test.ts.
 */

const TIERED: OAuthDescriptor = {
  kind: 'oauth2',
  endpoints: { issuer: 'https://source.test' },
  scopes: ['identity'],
  tiers: [
    { scopes: ['identity', 'a', 'b'], grants: ['a', 'b'] },
    { scopes: ['identity', 'a'], grants: ['a'] },
    { scopes: ['identity'], grants: [] },
  ],
  clientSettings: { id: 'ID', secret: 'SECRET' },
};
const { tiers: _tiers, ...PLAIN } = TIERED;

describe('Connector management', () => {
  describe('a refusal that says an administrator must approve is the only one answered by asking for less', () => {
    it.each([
      { situation: 'AADSTS65001 under access_denied', error: 'access_denied', description: 'AADSTS65001: The user or administrator has not consented.', needed: true },
      { situation: 'AADSTS90094 under consent_required', error: 'consent_required', description: 'AADSTS90094: The grant requires admin permission.', needed: true },
      { situation: 'AADSTS90094 under interaction_required', error: 'interaction_required', description: 'AADSTS90094: The grant requires admin permission.', needed: true },
      { situation: 'the person declining (AADSTS65004)', error: 'access_denied', description: 'AADSTS65004: The user declined to consent.', needed: false },
      { situation: 'a longer code that starts like one (AADSTS650010)', error: 'access_denied', description: 'AADSTS650010: Something else.', needed: false },
      { situation: 'an admin code under an error that is not about consent', error: 'server_error', description: 'AADSTS65001: not consented.', needed: false },
      { situation: 'access_denied with no description', error: 'access_denied', description: undefined, needed: false },
      { situation: 'no error at all', error: undefined, description: 'AADSTS65001: not consented.', needed: false },
    ])('is $needed for $situation', ({ error, description, needed }) => {
      expect(adminApprovalNeeded({ error, error_description: description })).toBe(needed);
    });
  });

  describe('a sign-in asks the next tier down, to the last, and never beyond it', () => {
    it('starts at the first tier for a source that asks in tiers, and at none for one that asks in none', () => {
      expect(firstTier(TIERED)).toEqual({ tier: 0 });
      expect(firstTier(PLAIN)).toEqual({});
    });

    it.each([
      { situation: 'the first tier', tier: 0, scopes: ['identity', 'a', 'b'], grants: ['a', 'b'] },
      { situation: 'the second tier', tier: 1, scopes: ['identity', 'a'], grants: ['a'] },
      { situation: 'the last tier', tier: 2, scopes: ['identity'], grants: [] },
    ])('asks the scopes and grants of $situation', ({ tier, scopes, grants }) => {
      expect(tierAsked(TIERED, { tier })).toEqual({ scopes, grants });
    });

    it.each([{ tier: undefined }, { tier: 3 }, { tier: 9 }])('asks nothing for tier $tier, which the description does not have, or names none', ({ tier }) => {
      expect(tierAsked(TIERED, { tier })).toBeNull();
    });

    it('asks the plain scopes, storing no grant, for a source that asks in no tiers, and nothing where an attempt names a tier anyway', () => {
      expect(tierAsked(PLAIN, {})).toEqual({ scopes: ['identity'], grants: null });
      expect(tierAsked(PLAIN, { tier: 0 })).toBeNull();
    });

    it('steps to the next tier with fresh secrets, keeping everything else the attempt carried', () => {
      const held = { ...newAttempt(), tier: 0, workspaceId: 'ws-1' };
      const fresh = newAttempt();

      const next = steppedDown(TIERED, held, fresh);

      expect(next).toEqual({ ...fresh, tier: 1, workspaceId: 'ws-1' });
      expect(next!.state).not.toBe(held.state);
    });

    it.each([
      { situation: 'the last tier', held: { tier: 2 }, auth: TIERED },
      { situation: 'a source that asks in no tiers', held: {}, auth: PLAIN },
      { situation: 'an attempt naming no tier on a source that asks in tiers', held: {}, auth: TIERED },
    ])('has nothing to step to from $situation', ({ held, auth }) => {
      expect(steppedDown(auth, { ...newAttempt(), ...held }, newAttempt())).toBeNull();
    });
  });
});
