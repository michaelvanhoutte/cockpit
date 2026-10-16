import { SourceError } from '@cockpit/connector-sdk';
import { describe, expect, it } from 'vitest';
import { mailboxOf } from '../../src/graph.js';
import { API, BUDGET, GraphWorld, TOKEN_URL, signedInHost } from './outlook-world.js';

/**
 * L1: an answer Graph refuses is thrown as the SDK's status error, carrying
 * the status it answered ("Show the source's HTTP status on a connection's
 * failed check", issue 1142), so the host can record it. Against a faked
 * source answer; a 401 stays the sign-in's, which Outlook's own sign-in tests
 * exercise.
 */

describe('Connector management', () => {
  describe('an answer Graph refuses is thrown with the status Graph gave', () => {
    it.each([503, 429, 403])('a listing answered %s is the status error carrying it', async (status) => {
      const world = new GraphWorld();
      world.failures.push({ prefix: 'messages', status });
      const mailbox = await mailboxOf(signedInHost(), {
        clientId: 'microsofts-own-client',
        clientSecret: 'microsofts-own-secret',
        callsPerRun: BUDGET,
        apiOrigin: API,
        endpoints: { tokenEndpoint: TOKEN_URL },
        fetch: world.fetch,
      });

      const thrown = await mailbox.get('messages').catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(SourceError);
      expect((thrown as SourceError).status).toBe(status);
      expect((thrown as SourceError).message).toContain(String(status));
      expect((thrown as SourceError).message).not.toMatch(/messages|https?:|\?|\/v1/);
    });
  });

  describe('the message holds no address', () => {
    it('a request that never got an answer says nothing of where it was sent', async () => {
      const address = `${API}/v1.0/me/messages?$filter=from/emailAddress/address eq 'person@example.com'`;
      const mailbox = await mailboxOf(signedInHost(), {
        clientId: 'microsofts-own-client',
        clientSecret: 'microsofts-own-secret',
        callsPerRun: BUDGET,
        apiOrigin: API,
        endpoints: { tokenEndpoint: TOKEN_URL },
        fetch: () => Promise.reject(new TypeError(`failed to fetch ${address}`)),
      });

      const thrown = await mailbox.get('messages').catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(SourceError);
      expect((thrown as SourceError).message).not.toMatch(/example\.com|messages|https?:/);
    });

    it('a refusal names the status and not the path it was for', async () => {
      const world = new GraphWorld();
      world.failures.push({ prefix: 'mailFolders/deleteditems', status: 403 });
      const mailbox = await mailboxOf(signedInHost(), {
        clientId: 'microsofts-own-client',
        clientSecret: 'microsofts-own-secret',
        callsPerRun: BUDGET,
        apiOrigin: API,
        endpoints: { tokenEndpoint: TOKEN_URL },
        fetch: world.fetch,
      });

      const thrown = await mailbox.get('mailFolders/deleteditems').catch((error: unknown) => error);

      expect((thrown as SourceError).status).toBe(403);
      expect((thrown as SourceError).message).not.toMatch(/mailFolders|deleteditems|\/v1/i);
    });
  });
});
