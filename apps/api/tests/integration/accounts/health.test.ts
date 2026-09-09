import { beforeEach, describe, expect, inject, it } from 'vitest';
import { SELF, applyD1Migrations, env } from 'cloudflare:test';
import { PROBE_NAME } from '../../../src/accounts/probe.js';
import {
  ACCOUNT_NAME,
  inStoreAsItIs,
  seedRegister,
  startFromEmpty,
} from '../seed.js';

/**
 * Integration level, through `SELF.fetch`, because the whole subject is the
 * wiring: that the route reaches a real store through a real binding and
 * reports what it found. Nothing below the HTTP entry point can be wrong in
 * the way this exists to catch - a deployment answering `ok` while every other
 * request fails.
 *
 * Why each case has a distinct path behind it: the register and the store are
 * two different dependencies that fail separately, and the name the check
 * practises on is a third decision, taken before either is touched.
 */

interface Verdict {
  ok: boolean;
  register: boolean;
  store: boolean;
  ai: boolean;
}

async function health(): Promise<Verdict> {
  const response = await SELF.fetch('http://cockpit.test/health');
  expect(response.status).toBe(200);
  return (await response.json()) as Verdict;
}

function tablesIn(name: string): Promise<string[]> {
  return inStoreAsItIs(name, (sql) =>
    sql
      .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .toArray()
      .map((row) => row.name),
  );
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  // The suite runs with no key (vitest.config.ts), and the two cases that care
  // set one for themselves - so it is put back here rather than left wherever
  // the last case left it.
  env.ANTHROPIC_API_KEY = '';
});

describe('Accounts', () => {
  describe('the deployment calls itself healthy only when an account’s data can be reached', () => {
    it('is healthy when the register answers and the updates apply', async () => {
      await seedRegister();

      expect(await health()).toEqual({ ok: true, register: true, store: true, ai: false });
    });

    it('is not healthy when an update cannot be applied', async () => {
      await seedRegister();
      // One of the tables the first update creates is already there, so that
      // update fails - the same shape as a schema change that cannot be
      // applied after a deploy, which is the case that used to answer `ok`.
      await inStoreAsItIs(PROBE_NAME, (sql) => sql.exec('CREATE TABLE commands (whatever text)'));

      expect(await health()).toMatchObject({ ok: false, register: true, store: false });
    });

    it('is not healthy when the register cannot be read', async () => {
      // Moved rather than dropped, and put back afterwards: D1's storage is not
      // rolled back between cases the way a store's is, so a case that breaks
      // the register breaks every case after it too.
      await env.DB.prepare('ALTER TABLE tenants RENAME TO tenants_out_of_reach').run();
      try {
        expect(await health()).toEqual({ ok: false, register: false, store: false, ai: false });
      } finally {
        await env.DB.prepare('ALTER TABLE tenants_out_of_reach RENAME TO tenants').run();
      }
    });

    it('refuses to practise on a name somebody has registered as an account', async () => {
      // The one way the check could reach real data, so it is refused rather
      // than assumed away: /health is outside the gate, so anyone at all can
      // reach it, and opening a registered account here would apply updates to
      // their data unasked.
      await env.DB.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)')
        .bind(PROBE_NAME, 'Somebody', '2026-08-12T00:00:00.000Z')
        .run();

      // `register` is asserted here too, not only `ok`: it is documented as
      // "answered, and does not contain the name below", and leaving it out is
      // what let it report true for the one state it is meant to deny.
      expect(await health()).toEqual({ ok: false, register: false, store: false, ai: false });
      expect(await tablesIn(PROBE_NAME)).toEqual([]);
    });

    it('never opens the data of an account somebody uses', async () => {
      await seedRegister();

      expect(await health()).toMatchObject({ ok: true });

      // The check made itself a store and left the account's alone. An account
      // store is created by the first request that opens it, so "no tables at
      // all" is exactly "nothing ever opened this".
      expect(await tablesIn(PROBE_NAME)).toContain('workspaces');
      expect(await tablesIn(ACCOUNT_NAME)).toEqual([]);
    });
  });

  /**
   * Integration rather than a unit test of the probe, because what could be
   * wrong is the wiring: the field has to survive the route's own response
   * schema, which drops anything it does not name, and it has to be answered
   * without changing the verdict.
   */
  describe('a deployment says whether it can clean up a captured note at all', () => {
    it.each([
      { situation: 'nothing was ever set up to read a note', key: '', reads: false },
      { situation: 'the reading was set up', key: 'a-key-that-proves-nothing-here', reads: true },
    ])('$situation', async ({ key, reads }) => {
      await seedRegister();
      env.ANTHROPIC_API_KEY = key;

      const verdict = await health();

      expect(verdict.ai).toBe(reads);
      // **And the deployment is healthy either way**, which is the point: a
      // Cockpit that cannot clean up a note still takes every note it is given.
      expect(verdict.ok).toBe(true);
    });
  });
});
