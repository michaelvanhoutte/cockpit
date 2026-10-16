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
    });
  });
});
