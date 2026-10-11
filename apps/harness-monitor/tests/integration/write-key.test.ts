import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { emptyTheDatabase, send, storedRequestIds, usage } from './support';

beforeEach(emptyTheDatabase);

describe('Harness Monitor', () => {
  describe('only the write key adds rows', () => {
    it.each([
      { situation: 'no key', headers: {}, status: 401 },
      { situation: 'a wrong key', headers: { authorization: 'Bearer not-the-key' }, status: 401 },
    ])('$situation is refused and nothing is stored', async ({ headers, status }) => {
      const response = await send([usage('r1')], headers);

      expect(response.status).toBe(status);
      expect(await storedRequestIds()).toEqual([]);
    });

    it('the right key is stored', async () => {
      const response = await send([usage('r1')]);

      expect(response.status).toBe(200);
      expect(await storedRequestIds()).toEqual(['r1']);
    });

    it('with no key configured on the Worker, every write is refused, even one carrying a key', async () => {
      const configured = env.HARNESS_WRITE_KEY;
      delete env.HARNESS_WRITE_KEY;
      try {
        const withKey = await send([usage('r1')]);
        const withoutKey = await send([usage('r2')], {});

        expect([withKey.status, withoutKey.status]).toEqual([503, 503]);
        expect(await storedRequestIds()).toEqual([]);
      } finally {
        if (configured !== undefined) env.HARNESS_WRITE_KEY = configured;
      }
    });

    it('the public page needs no key', async () => {
      const response = await SELF.fetch('https://monitor.test/');

      expect(response.status).toBe(200);
    });
  });
});
