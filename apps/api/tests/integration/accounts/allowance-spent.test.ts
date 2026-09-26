import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { applyD1Migrations, env, runInDurableObject, SELF } from 'cloudflare:test';
import { PROBE_NAME } from '../../../src/accounts/probe.js';
import {
  ACCOUNT_NAME,
  OTHER_ACCOUNT_NAME,
  USER_ID,
  asUser,
  seedRegister,
  startFromEmpty,
  storeNamed,
} from '../seed.js';

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
      await spendAllowanceOf(OTHER_ACCOUNT_NAME);

      expect(await storeNamed(OTHER_ACCOUNT_NAME).workspaces(OTHER_ACCOUNT_NAME)).toEqual({
        status: 'allowance-spent',
      });
    });

    it('answers as a spent allowance when it arrives while doing the work', async () => {
      // Up to date first, so what fails is the work and not the update.
      expect((await storeNamed(ACCOUNT_NAME).workspaces(ACCOUNT_NAME)).status).toBe('ok');
      await spendAllowanceOf(ACCOUNT_NAME);

      expect(await storeNamed(ACCOUNT_NAME).workspaces(ACCOUNT_NAME)).toEqual({
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

    it('answers 503 for a call that meets the limit outside an answer from the store', async () => {
      // How many workspaces an account holds is read directly rather than
      // through an answer, so the limit reaches the route as a bare error.
      await spendAllowanceOf(ACCOUNT_NAME);

      const response = await asUser(`http://cockpit.test/v1/admin/users/${USER_ID}/account`);

      expect(response.status).toBe(503);
      expect(((await response.json()) as { error: string }).error).toMatch(/allowance/);
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

    it('says so on /health when the store cannot even be reached to be asked', async () => {
      // The stub itself failing, rather than the store answering: what the
      // check has to read is the message, as the route's own fallback does.
      vi.spyOn(env.ACCOUNT, 'get').mockImplementation(() => {
        throw new Error(QUOTA);
      });

      expect(await (await SELF.fetch('http://cockpit.test/health')).json()).toMatchObject({
        ok: false,
        store: false,
        allowanceSpent: true,
      });
    });

    it('does not mistake a name somebody typed for the limit', async () => {
      // A collision names what was typed, so a name that reads like the limit
      // must still come back as the collision it is.
      const name = QUOTA;
      const make = (id: string) =>
        asUser('http://cockpit.test/v1/commands/create_workspace', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            commandId: `018f2222-0000-7000-8000-00000000000${id}`,
            issuedAt: '2026-09-26T10:00:00.000Z',
            workspaceId: `018f2222-0000-7000-8000-00000000001${id}`,
            panelId: `018f2222-0000-7000-8000-00000000002${id}`,
            name,
          }),
        });
      expect((await make('1')).status).toBe(200);

      const again = await make('2');

      expect(again.status).toBe(409);
    });
  });
});
