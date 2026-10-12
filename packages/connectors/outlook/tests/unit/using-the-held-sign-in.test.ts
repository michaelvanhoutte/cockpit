import { describe, expect, it } from 'vitest';
import { ORGANISATION_WITHDREW, SIGN_IN_NOT_KEPT, SIGN_IN_REFUSED, SIGN_IN_UNREADABLE } from '../../src/graph.js';
import { CONSENT_WITHDRAWN, INVALID_GRANT, refreshAnswer } from '../graph-payloads.js';
import { FakeHost } from './fake-host.js';
import { GraphWorld, TOKEN_URL, signedInHost } from './outlook-world.js';

/**
 * L1, against a fake host and Microsoft faked at the network: the sign-in a
 * connection holds is used while it lasts, refreshed when it has lapsed, and
 * handed back - the refresh token Microsoft rotated included - before the new
 * token is used ("Build Outlook as a connector package on the SDK,
 * unregistered", issue 1046).
 */

const tokenRequests = (world: GraphWorld) => world.requests.filter((one) => one.includes(new URL(TOKEN_URL).pathname));

/** A host that notes how many requests had been made when it was handed a credential. */
class WitnessHost extends FakeHost {
  seenAt: number[] = [];
  constructor(inner: FakeHost, private readonly world: GraphWorld) {
    super({ credential: inner.credential });
  }
  override async setCredentials(credentials: Record<string, string>): Promise<void> {
    this.seenAt.push(this.world.requests.length);
    await super.setCredentials(credentials);
  }
}

describe('Connector management', () => {
  describe('an access token is used while it lasts, and refreshed into the same credential', () => {
    it('uses the one the sign-in sealed while it has time left, and refreshes nothing', async () => {
      const world = new GraphWorld();
      const host = signedInHost();

      await world.connector().sync(host);

      expect(tokenRequests(world)).toEqual([]);
      expect(host.credentialsSaved).toEqual([]);
    });

    it.each([
      { situation: 'lapsed', expiresAt: '2026-10-09T11:00:00.000Z' },
      { situation: 'under a minute from lapsing', expiresAt: '2026-10-09T12:00:30.000Z' },
      { situation: 'of no known expiry, as the sign-in leaves it', expiresAt: null },
    ])('refreshes one $situation, and hands back the new one with the rotated refresh token before it is used', async ({ expiresAt }) => {
      const world = new GraphWorld();
      world.arrives('m-1', { flag: 'flagged' });
      const host = new WitnessHost(signedInHost({ expiresAt, accessToken: 'an-old-one' }), world);

      await world.connector().sync(host);

      expect(host.credentialsSaved).toHaveLength(1);
      expect(JSON.parse(host.credentialsSaved[0]!.credential!)).toMatchObject({
        refresh_token: 'a-rotated-refresh-token',
        access_token: 'a-good-access-token',
        expires_at: '2026-10-09T12:59:59.000Z',
      });
      // Handed back after the one request to the token endpoint, before any to Graph.
      expect(host.seenAt).toEqual([1]);
      expect(host.filed.size).toBe(1);
    });

    it('keeps the refresh token it had where the answer carries none', async () => {
      const world = new GraphWorld();
      const { refresh_token: _rotated, ...unrotated } = refreshAnswer();
      world.refresh = { status: 200, body: unrotated };
      const host = signedInHost({ expiresAt: null });

      await world.connector().sync(host);

      expect(JSON.parse(host.credentialsSaved[0]!.credential!)).toMatchObject({ refresh_token: 'the-refresh-token' });
    });

    it('refreshes once when Microsoft refuses a token it was still holding, then carries on', async () => {
      const world = new GraphWorld();
      world.arrives('m-1', { flag: 'flagged' });
      const host = signedInHost({ accessToken: 'revoked-early' });

      await world.connector().sync(host);

      expect(host.credentialsSaved).toHaveLength(1);
      expect(host.filed.size).toBe(1);
    });
  });

  describe('a connection whose sign-in Microsoft no longer accepts says so and changes nothing', () => {
    it.each([
      { situation: 'revoked', status: 400, body: INVALID_GRANT, says: SIGN_IN_REFUSED },
      { situation: 'refused with 401', status: 401, body: INVALID_GRANT, says: SIGN_IN_REFUSED },
      { situation: 'refused because the organisation withdrew consent', status: 400, body: CONSENT_WITHDRAWN, says: ORGANISATION_WITHDREW },
    ])('fails with the reason when the refresh token is $situation', async ({ status, body, says }) => {
      const world = new GraphWorld();
      world.refresh = { status, body };
      world.arrives('m-1', { flag: 'flagged' });
      const host = signedInHost({ expiresAt: null });

      await expect(world.connector().sync(host)).rejects.toThrow(says);

      expect(host.filed.size).toBe(0);
      expect(host.state).toBeNull();
    });

    it('fails with the reason when Microsoft refuses even a fresh token', async () => {
      const world = new GraphWorld();
      world.acceptedToken = 'something-else';

      await expect(world.connector().sync(signedInHost())).rejects.toThrow(SIGN_IN_REFUSED);
    });

    it('does not fail on Microsoft only failing to answer a refresh this time', async () => {
      const world = new GraphWorld();
      world.refresh = { status: 503, body: {} };
      world.arrives('m-1', { flag: 'flagged' });
      const host = signedInHost({ expiresAt: null });

      await expect(world.connector().sync(host)).resolves.toBeUndefined();

      expect(host.filed.size).toBe(0);
      expect(host.listings).toEqual([]);
    });

    it('fails “connect again” rather than carry on when the host did not keep the refresh token Microsoft rotated', async () => {
      const world = new GraphWorld();
      world.arrives('m-1', { flag: 'flagged' });
      const host = signedInHost({ expiresAt: null });
      host.setCredentials = async () => {
        throw new Error('the store is down');
      };

      await expect(world.connector().sync(host)).rejects.toThrow(SIGN_IN_NOT_KEPT);

      expect(world.requests.every((one) => one.includes(new URL(TOKEN_URL).pathname))).toBe(true);
      expect(host.filed.size).toBe(0);
    });

    it('fails “connect again” for a stored sign-in it cannot read', async () => {
      const world = new GraphWorld();
      const host = new FakeHost({ credential: { credential: 'not json' } });

      await expect(world.connector().sync(host)).rejects.toThrow(SIGN_IN_UNREADABLE);
    });
  });
});
