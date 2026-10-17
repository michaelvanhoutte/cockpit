import { afterEach, describe, expect, it, vi } from 'vitest';
import { SourceError } from '@cockpit/connector-sdk';
import { botFrameworkKeys } from '../../src/index.js';

/**
 * L1, against a faked answer: where Teams' side answers with a status the
 * connector refuses, it throws the SDK's error carrying that status, so the
 * connection's history can show it ("See what each Teams save became, in its
 * connection's history", issue 1144). The message names no address.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Connector management', () => {
  describe('Teams throws the status error for a source answer it refuses', () => {
    it.each([404, 429, 502])('carries the status %i the Bot Framework answered the key metadata with', async (status) => {
      // A different address per run: the key set is held per address.
      const metadataUrl = `https://login.botframework.test/${crypto.randomUUID()}/openidconfiguration`;
      vi.stubGlobal('fetch', async () => new Response('unavailable', { status }));

      const thrown = await (async () =>
        botFrameworkKeys(metadataUrl)({ alg: 'RS256' }, { payload: '', signature: '' }))().catch(
        (error: unknown) => error,
      );

      expect(thrown).toBeInstanceOf(SourceError);
      expect((thrown as SourceError).status).toBe(status);
      expect((thrown as SourceError).message).toContain(String(status));
      expect((thrown as SourceError).message).not.toMatch(/https?:|botframework\.test|openidconfiguration/);
    });
  });
});
