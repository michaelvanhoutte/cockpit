import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { applyD1Migrations, env, runInDurableObject, SELF } from 'cloudflare:test';
import { PROBE_NAME } from '../../../src/accounts/probe.js';
import { ACCOUNT_NAME, asUser, seedRegister, startFromEmpty, storeNamed } from '../seed.js';

/**
 * Integration level, through the real Worker and a real store, because what
 * could be wrong is the wiring: the answer has to survive the Durable Object
 * boundary, the route's error handler and `/health`'s response schema.
 *
 * The limit itself cannot be spent here, so a store's queries are made to throw
 * the message Cloudflare gives - before it is up to date, and after.
 */

const QUOTA = 'Exceeded allowed rows read in Durable Objects free tier';

/** Makes every query this store runs from now on fail as the exhausted free tier does. */
async function spendAllowanceOf(name: string): Promise<void> {
  await runInDurableObject(storeNamed(name), (_instance, state) => {
    vi.spyOn(state.storage.sql, 'exec').mockImplementation(() => {
      throw new Error(QUOTA);
    });
  });
}

afterEach(() => vi.restoreAllMocks());

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
});

describe('Accounts', () => {
  describe('a store that has spent its daily allowance says so', () => {
    it('answers as a spent allowance when it arrives while bringing the store up to date', async () => {
      await spendAllowanceOf('a-fresh-account');

      expect(await storeNamed('a-fresh-account').workspaces('a-fresh-account')).toEqual({
        status: 'allowance-spent',
      });
    });

    it('answers as a spent allowance when it arrives while doing the work', async () => {
      // Up to date first, so what fails is the work and not the update.
      expect((await storeNamed('a-busy-account').workspaces('a-busy-account')).status).toBe('ok');
      await spendAllowanceOf('a-busy-account');

      expect(await storeNamed('a-busy-account').workspaces('a-busy-account')).toEqual({
        status: 'allowance-spent',
      });
    });

    it('answers a request 503, naming the limit and no account', async () => {
      await spendAllowanceOf(ACCOUNT_NAME);

      const response = await asUser('http://cockpit.test/v1/workspaces');

      expect(response.status).toBe(503);
      const { error } = (await response.json()) as { error: string };
      expect(error).toMatch(/allowance/);
      expect(error).not.toContain(ACCOUNT_NAME);
      expect(error).not.toMatch(/brought up to date/);
    });

    it('lets /health say the limit is spent alongside store: false', async () => {
      await spendAllowanceOf(PROBE_NAME);

      const response = await SELF.fetch('http://cockpit.test/health');

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: false,
        register: true,
        store: false,
        allowanceSpent: true,
      });
    });

    it('leaves /health unchanged when the store is well', async () => {
      const body = await (await SELF.fetch('http://cockpit.test/health')).json();

      expect(body).not.toHaveProperty('allowanceSpent');
    });
  });
});
