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
 * (docs/deployment.md, "Bootstrap runbook"), which is exactly why what happens
 * to rows that were already there is worth pinning.
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

interface Person {
  id: string;
  name: string;
  email: string | null;
  google_subject: string | null;
}

async function everybody(): Promise<Person[]> {
  const { results } = await env.DB.prepare(
    'SELECT id, name, email, google_subject FROM users ORDER BY id',
  ).all<Person>();
  return results;
}

/**
 * The three states this file asks questions about, all reached in `beforeAll`
 * because each is produced by an event that can only happen once. Reading them
 * as they are made, rather than in the cases, is what keeps a case from
 * depending on the one before it having run.
 */
let afterTheUpdate: Person[];
let afterRunningItAgain: Person[];
let secondRun: unknown;

/** The address somebody is really given, the way the runbook gives one: by hand. */
const ADA_FOR_REAL = 'ada@her-own-domain.example.net';

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
  afterTheUpdate = await everybody();

  // Somebody is given their real address, which is the step the runbook says
  // happens by hand once - and the thing a re-run must not undo.
  await env.DB.prepare('UPDATE users SET email = ? WHERE id = ?')
    .bind(ADA_FOR_REAL, 'user-ada')
    .run();

  // The deploy that failed after this file had already been applied, retried:
  // its statements run again, not through `applyD1Migrations`, which keeps its
  // own record of what it has applied and would do nothing at all.
  const again = inject('migrations')
    .filter((m) => m.name.startsWith('0011'))
    .flatMap((m) => m.queries)
    .map((query) => env.DB.prepare(query));
  secondRun = await env.DB.batch(again).then(
    () => null,
    (error: unknown) => error,
  );
  afterRunningItAgain = await everybody();
});

describe('Sign-in', () => {
  describe('people who were in the register before it could record a Google account keep their place in it', () => {
    it('gives the two the register was started with an address', () => {
      expect(afterTheUpdate).toContainEqual({
        id: 'user-michael',
        name: 'Michael',
        email: 'michael@example.com',
        google_subject: null,
      });
      expect(afterTheUpdate).toContainEqual({
        id: 'user-ada',
        name: 'Ada',
        email: 'ada@example.com',
        google_subject: null,
      });
    });

    /**
     * The alternative - inventing an address for somebody the update was never
     * told about - is how a person ends up allowed in under a name nobody chose.
     * A row with no address is simply one nobody can sign in as.
     */
    it('leaves anybody it was not told about without one', () => {
      expect(afterTheUpdate).toContainEqual({
        id: 'user-anna',
        name: 'Anna',
        email: null,
        google_subject: null,
      });
    });
  });

  /**
   * A migration file that fails partway is re-run whole by the next deploy, so
   * the half of this update that can fail on the data it finds is written to
   * survive being run twice ("Record the Google account each user signs in
   * with", issue 195). Nothing else exercises that: applying it once is what
   * every other test in this folder does, and the guards that make the retry
   * safe could be deleted without a single case going red.
   */
  describe('running the update a second time changes nobody', () => {
    it('finishes rather than failing on what the first run left', () => {
      expect(secondRun).toBeNull();
    });

    it('leaves an address somebody was really given alone', () => {
      expect(afterRunningItAgain).toContainEqual({
        id: 'user-ada',
        name: 'Ada',
        email: ADA_FOR_REAL,
        google_subject: null,
      });
    });

    it('leaves everybody else exactly as they were', () => {
      expect(afterRunningItAgain.filter((person) => person.id !== 'user-ada')).toEqual(
        afterTheUpdate.filter((person) => person.id !== 'user-ada'),
      );
    });
  });
});
