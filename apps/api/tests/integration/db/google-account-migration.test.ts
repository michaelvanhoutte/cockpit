import { beforeAll, describe, expect, inject, it } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';

/**
 * Integration level, and its own file: what it arranges is a register in the
 * state a deployed one is actually in - people who were written before there
 * was anywhere to record a Google account - and applying an update can only
 * happen once.
 *
 * It is the case none of the other tests in this folder can reach. They start
 * from an empty database with every migration applied, so the backfill has
 * nothing to find and its rows are never exercised at all. Staging is
 * deliberately never re-seeded and production was seeded once by hand
 * (docs/deployment.md, "Bootstrap runbook"), which is exactly why
 * what happens to rows that were already there is worth pinning.
 */
const AT = '2026-08-12T10:00:00.000Z';

/**
 * Everything before the two migrations that add a Google account to a person,
 * and then those two and anything after them.
 *
 * Split by where a migration sorts rather than by naming the two, because the
 * complement of "is one of these two" is not "came before them": it would sweep
 * every migration written after this test into the first half and apply it out
 * of order, which is a failure the next person to add one would have to debug
 * rather than read.
 */
const FIRST_WITH_A_GOOGLE_ACCOUNT = '0010';

function beforeAnybodyHadAGoogleAccount() {
  return inject('migrations').filter((m) => m.name < FIRST_WITH_A_GOOGLE_ACCOUNT);
}
function theRest() {
  return inject('migrations').filter((m) => m.name >= FIRST_WITH_A_GOOGLE_ACCOUNT);
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, beforeAnybodyHadAGoogleAccount());

  // What a deployed register holds: seed.sql's two people, and - because there
  // is no reason to assume otherwise - somebody the seed never put there.
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO tenants (id, name, created_at) VALUES
         ('tenant-default', 'Michael', ?), ('tenant-ada', 'Ada', ?), ('tenant-anna', 'Anna', ?)`,
    ).bind(AT, AT, AT),
    env.DB.prepare(
      `INSERT INTO users (id, name, account_id, role, created_at) VALUES
         ('user-michael', 'Michael', 'tenant-default', 'admin', ?),
         ('user-ada', 'Ada', 'tenant-ada', 'user', ?),
         ('user-anna', 'Anna', 'tenant-anna', 'user', ?)`,
    ).bind(AT, AT, AT),
  ]);

  await applyD1Migrations(env.DB, theRest());
});

describe('Sign-in', () => {
  describe('people who were in the register before it could record a Google account keep their place in it', () => {
    it('gives the two the register was started with an address', async () => {
      const { results } = await env.DB.prepare(
        "SELECT id, name, email FROM users WHERE id IN ('user-michael', 'user-ada') ORDER BY id",
      ).all<{ id: string; name: string; email: string | null }>();

      expect(results).toEqual([
        { id: 'user-ada', name: 'Ada', email: 'ada@example.com' },
        { id: 'user-michael', name: 'Michael', email: 'michael@example.com' },
      ]);
    });

    /**
     * The alternative - inventing an address for somebody the update was never
     * told about - is how a person ends up allowed in under a name nobody chose.
     * A row with no address is simply one nobody can sign in as.
     */
    it('leaves anybody it was not told about without one', async () => {
      const row = await env.DB.prepare(
        "SELECT name, email, google_subject FROM users WHERE id = 'user-anna'",
      ).first<{ name: string; email: string | null; google_subject: string | null }>();

      expect(row).toEqual({ name: 'Anna', email: null, google_subject: null });
    });
  });
});
