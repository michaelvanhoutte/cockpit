import { SourceError } from '@cockpit/connector-sdk';
import { describe, expect, it } from 'vitest';
import { mailboxOf } from '../../src/mailbox.js';
import { API, GmailWorld, REVOKE_URL, TOKEN_URL, signedInHost } from './gmail-world.js';

/**
 * L1: an answer Gmail refuses is thrown as the SDK's status error, carrying
 * the status it answered ("Show the source's HTTP status on a connection's
 * failed check", issue 1142), so the host can record it. Against a faked
 * source answer; a 401 stays the sign-in's, which Gmail's own sign-in tests
 * exercise.
 */

describe('Connector management', () => {
  describe('an answer Gmail refuses is thrown with the status Gmail gave', () => {
    it.each([503, 429])('a listing answered %s is the status error carrying it', async (status) => {
      const world = new GmailWorld();
      world.failures.push({ prefix: 'threads', status });
      const mailbox = await mailboxOf(signedInHost(), {
        clientId: 'gmails-own-client',
        clientSecret: 'gmails-own-secret',
        apiOrigin: API,
        endpoints: { tokenEndpoint: TOKEN_URL, revocationEndpoint: REVOKE_URL },
        fetch: world.fetch,
      });

      const thrown = await mailbox.get('threads?q=in:inbox').catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(SourceError);
      expect((thrown as SourceError).status).toBe(status);
      expect((thrown as SourceError).message).toContain(String(status));
      expect((thrown as SourceError).message).not.toMatch(/threads|in:inbox|https?:|\?|\//);
    });
  });

  describe('the message holds no address', () => {
    it('a request that never got an answer says nothing of where it was sent', async () => {
      const address = `${API}/gmail/v1/users/me/threads?q=person@example.com`;
      const mailbox = await mailboxOf(signedInHost(), {
        clientId: 'gmails-own-client',
        clientSecret: 'gmails-own-secret',
        apiOrigin: API,
        endpoints: { tokenEndpoint: TOKEN_URL, revocationEndpoint: REVOKE_URL },
        fetch: () => Promise.reject(new TypeError(`failed to fetch ${address}`)),
      });

      const thrown = await mailbox.get('threads?q=person@example.com').catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(SourceError);
      expect((thrown as SourceError).message).not.toMatch(/example\.com|threads|https?:/);
    });
  });
});
