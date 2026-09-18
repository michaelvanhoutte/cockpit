import { describe, expect, it } from 'vitest';
import { BOT_FRAMEWORK_ISSUER, OPEN_ID_METADATA_URL } from '../../src/index.js';

/**
 * The contract tier: what every level below fakes, asked of Microsoft itself
 * (docs/testing-strategy.md, "Third parties"; architecture, "Connectors:
 * plugin-shaped, host-blind").
 *
 * **Scheduled rather than run on a change** (.github/workflows/contract.yml):
 * it reaches the network, and what it holds is somebody else's decision rather
 * than ours. A failure here means Microsoft has moved and the fakes below it
 * are describing a world that no longer exists - which makes updating them
 * priority work, never something to re-run until it passes.
 */

interface Metadata {
  issuer?: unknown;
  jwks_uri?: unknown;
  id_token_signing_alg_values_supported?: unknown;
}

interface KeySet {
  keys?: { kty?: unknown; use?: unknown; kid?: unknown; n?: unknown; e?: unknown }[];
}

async function metadata(): Promise<Metadata> {
  const answer = await fetch(OPEN_ID_METADATA_URL);
  expect(answer.ok, `${OPEN_ID_METADATA_URL} answered ${answer.status}`).toBe(true);
  return (await answer.json()) as Metadata;
}

describe('Capture', () => {
  describe('Microsoft still signs a saved message the way this Cockpit checks it', () => {
    it('publishes the issuer a channel call is refused unless it names', async () => {
      expect((await metadata()).issuer).toBe(BOT_FRAMEWORK_ISSUER);
    });

    it('publishes a key set of RSA signing keys, over HTTPS', async () => {
      const where = (await metadata()).jwks_uri;
      expect(typeof where).toBe('string');
      expect(String(where).startsWith('https://')).toBe(true);

      const answer = await fetch(String(where));
      expect(answer.ok, `${String(where)} answered ${answer.status}`).toBe(true);
      const published = (await answer.json()) as KeySet;

      expect(published.keys?.length ?? 0).toBeGreaterThan(0);
      for (const key of published.keys ?? []) {
        expect(key.kty).toBe('RSA');
        expect(typeof key.kid).toBe('string');
      }
    });

    it('still signs with an algorithm this checks against', async () => {
      // `jose` verifies whatever the key set declares, so what matters is that
      // RS256 is still among what Microsoft says it signs with - the day it is
      // not, every call this address gets would be refused as unsigned.
      const algorithms = (await metadata()).id_token_signing_alg_values_supported;

      expect(Array.isArray(algorithms) ? algorithms : []).toContain('RS256');
    });
  });
});
