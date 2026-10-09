import { describe, expect, it } from 'vitest';
import { NO_LABEL } from '../../src/sync.js';
import { SIGN_IN_REFUSED } from '../../src/mailbox.js';
import { FakeHost } from './fake-host.js';
import { GmailWorld, TOKEN_URL, signedInHost } from './gmail-world.js';

/**
 * L1, against a fake host and Gmail faked at the network: the sign-in a
 * connection holds is used while it lasts, refreshed when it has lapsed, and
 * handed back so the next run has the new one ("Build Gmail as a connector
 * package on the SDK, unregistered", issue 943). It reads only the shape the
 * generic sign-in seals.
 */

describe('Connector management', () => {
  describe('an access token is used while it lasts, and refreshed into the same credential', () => {
    it('uses the one the sign-in sealed while it has time left, and refreshes nothing', async () => {
      const world = new GmailWorld();
      const host = signedInHost();

      await world.connector().sync(host);

      expect(world.requests.some((one) => one.includes(TOKEN_URL.replace('https://oauth.example.test', '')))).toBe(false);
      expect(host.credentialsSaved).toEqual([]);
    });

    it.each([
      { situation: 'lapsed', expiresAt: '2026-10-09T11:00:00.000Z' },
      { situation: 'under a minute from lapsing', expiresAt: '2026-10-09T12:00:30.000Z' },
      { situation: 'of no known expiry, as the sign-in leaves it', expiresAt: null },
    ])('refreshes one $situation, and hands the new one back with the refresh token kept', async ({ expiresAt }) => {
      const world = new GmailWorld();
      const host = signedInHost({ expiresAt, accessToken: 'an-old-one' });

      await world.connector().sync(host);

      expect(host.credentialsSaved).toHaveLength(1);
      expect(JSON.parse(host.credentialsSaved[0]!.credential!)).toMatchObject({
        refresh_token: 'the-refresh-token',
        access_token: 'a-good-access-token',
        expires_at: '2026-10-09T12:59:59.000Z',
      });
    });

    it('refreshes once when Google refuses a token it was still holding, then carries on', async () => {
      const world = new GmailWorld();
      world.arrives('t-1', 'One');
      const host = signedInHost({ accessToken: 'revoked-early' });

      await world.connector().sync(host);

      expect(host.credentialsSaved).toHaveLength(1);
      expect(host.filed.size).toBe(1);
    });
  });

  describe('a connection whose sign-in Google no longer accepts says so and changes nothing', () => {
    it.each([400, 401])('fails with the reason when Google refuses to refresh it, answering %s', async (status) => {
      const world = new GmailWorld();
      world.refreshAnswer = { status, body: { error: 'invalid_grant' } };
      world.arrives('t-1', 'One');
      const host = signedInHost({ expiresAt: null });

      await expect(world.connector().sync(host)).rejects.toThrow(SIGN_IN_REFUSED);

      expect(host.filed.size).toBe(0);
      expect(host.state).toBeNull();
    });

    it('fails with the reason when Google refuses even a fresh token', async () => {
      const world = new GmailWorld();
      world.acceptedToken = 'something-else';

      await expect(world.connector().sync(signedInHost())).rejects.toThrow(SIGN_IN_REFUSED);
    });

    it('does not fail on Google only failing to answer a refresh this time', async () => {
      const world = new GmailWorld();
      world.refreshAnswer = { status: 503, body: {} };

      const failure = await world.connector().sync(signedInHost({ expiresAt: null })).catch((error: unknown) => error as Error);

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(/503/);
      expect((failure as Error).message).not.toBe(SIGN_IN_REFUSED);
    });

    it.each([
      { situation: 'holding nothing', credential: {} },
      { situation: 'not JSON', credential: { credential: 'sealed garbage' } },
      { situation: 'holding no refresh token', credential: { credential: JSON.stringify({ access_token: 'x' }) } },
    ])('fails, asking to connect again, on a stored sign-in $situation', async ({ credential }) => {
      const world = new GmailWorld();

      await expect(world.connector().sync(new FakeHost({ credential }))).rejects.toThrow(/Connect again/);
    });
  });

  describe('a connection to a mailbox with no label called Cockpit says what to do, unless it follows the star', () => {
    it('fails with the reason when following the label', async () => {
      const world = new GmailWorld();
      world.hasLabel = false;

      await expect(world.connector().sync(signedInHost())).rejects.toThrow(NO_LABEL);
    });

    it('does not fail when following the star, which asks nothing of the labels', async () => {
      const world = new GmailWorld();
      world.hasLabel = false;

      await expect(world.connector().sync(signedInHost({ choice: 'star' }))).resolves.toBeUndefined();
    });

    it('fails when asked to mirror a closed Task to a label that is not there', async () => {
      const world = new GmailWorld();
      world.hasLabel = false;

      await expect(
        world.connector().mirrorOpenState!(signedInHost(), [{ sourceId: 't-1', open: false }]),
      ).rejects.toThrow(NO_LABEL);
    });
  });
});
