import { beforeEach, describe, expect, inject, it } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import {
  ACCOUNT_NAME,
  OTHER_ACCOUNT_NAME,
  OTHER_USER_ID,
  WORKSPACE_ID,
  asUser,
  inStoreAsItIs,
  inTheStore,
  seedRegister,
  signInAs,
  startFromEmpty,
  storeNamed,
} from '../seed.js';

/**
 * Integration level, through the real Worker (`asUser`), for the reason
 * `decision-history.test.ts` beside this file is: whether a correction lands,
 * clears, or leaves the summary untouched is a fact about the store, not
 * about a pure function ("Show what the system learned, in a sentence you can
 * correct", issue 301).
 */

let seq = 0;
function nextId(): string {
  seq += 1;
  return `018f0000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
}

const AT = '2026-09-10T10:00:00.000Z';

async function setCorrection(correction: string, workspaceId = WORKSPACE_ID, userId?: string) {
  return asUser(
    'http://cockpit.test/v1/commands/set_routing_summary_correction',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: nextId(), issuedAt: AT, workspaceId, correction }),
    },
    userId,
  );
}

/**
 * Brought up to date first, unlike `inStoreAsItIs` alone - a store nothing
 * has opened yet has no `workspace_routing_summary` table at all
 * (`accounts/changes.ts`), which several cases here read before ever
 * sending a command that would open it.
 */
async function rowFor(accountName: string, workspaceId: string) {
  const opened = await storeNamed(accountName).workspaces(accountName);
  if (opened.status !== 'ok') throw new Error(JSON.stringify(opened));
  const rows = await inStoreAsItIs(accountName, (sql) =>
    sql
      .exec<{
        summary: string | null;
        summary_generated_at: string | null;
        correction: string | null;
        correction_set_at: string | null;
      }>(
        'SELECT summary, summary_generated_at, correction, correction_set_at FROM workspace_routing_summary WHERE tenant_id = ? AND workspace_id = ?',
        accountName,
        workspaceId,
      )
      .toArray(),
  );
  return rows[0] ?? null;
}

/** A summary already sitting on the row, written the way the nightly job writes one - directly, since it is Cockpit's own to send. */
async function aStoredSummary(text: string, generatedAt = '2026-09-09T03:00:00.000Z'): Promise<void> {
  await inTheStore((sql) =>
    sql.exec(
      `INSERT INTO workspace_routing_summary (workspace_id, tenant_id, summary, summary_generated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (workspace_id) DO UPDATE SET summary = excluded.summary, summary_generated_at = excluded.summary_generated_at`,
      WORKSPACE_ID,
      ACCOUNT_NAME,
      text,
      generatedAt,
    ),
  );
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  await signInAs();
  await signInAs(OTHER_USER_ID);
  seq = 0;
});

describe('What Cockpit has learned', () => {
  describe('writing a correction', () => {
    it('creates the row where none exists yet, writing only the correction', async () => {
      expect(await rowFor(ACCOUNT_NAME, WORKSPACE_ID)).toBeNull();

      expect((await setCorrection('Sign-off questions go to Laurens.')).status).toBe(200);

      const row = await rowFor(ACCOUNT_NAME, WORKSPACE_ID);
      expect(row).toMatchObject({
        correction: 'Sign-off questions go to Laurens.',
        correction_set_at: AT,
        summary: null,
        summary_generated_at: null,
      });
    });

    it('never touches the summary the nightly job wrote', async () => {
      await aStoredSummary('You file compliance questions to Compliance questions.');

      expect((await setCorrection('Sign-off questions go to Laurens.')).status).toBe(200);

      const row = await rowFor(ACCOUNT_NAME, WORKSPACE_ID);
      expect(row?.summary).toBe('You file compliance questions to Compliance questions.');
      expect(row?.summary_generated_at).toBe('2026-09-09T03:00:00.000Z');
      expect(row?.correction).toBe('Sign-off questions go to Laurens.');
    });

    it('replaces an earlier correction rather than adding to it', async () => {
      await setCorrection('First correction.');

      expect((await setCorrection('Second, replacing the first.')).status).toBe(200);

      expect((await rowFor(ACCOUNT_NAME, WORKSPACE_ID))?.correction).toBe('Second, replacing the first.');
    });

    it('clears the correction back to null when sent the empty string', async () => {
      await setCorrection('Sign-off questions go to Laurens.');

      expect((await setCorrection('')).status).toBe(200);

      const row = await rowFor(ACCOUNT_NAME, WORKSPACE_ID);
      expect(row?.correction).toBeNull();
    });

    it('is refused for a workspace that does not exist', async () => {
      const response = await setCorrection('Sign-off questions go to Laurens.', 'ws-does-not-exist');
      expect(response.status).toBe(404);
    });

    it('is refused when it runs well over the cap, before it ever reaches the store', async () => {
      const response = await setCorrection('x'.repeat(2_001));
      expect(response.status).not.toBe(200);
      expect(await rowFor(ACCOUNT_NAME, WORKSPACE_ID)).toBeNull();
    });

    it('writes the correction once, not twice, when the same command is replayed', async () => {
      const body = {
        commandId: nextId(),
        issuedAt: AT,
        workspaceId: WORKSPACE_ID,
        correction: 'Sign-off questions go to Laurens.',
      };
      const once = () =>
        asUser('http://cockpit.test/v1/commands/set_routing_summary_correction', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });

      const first = await once();
      const second = await once();

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect((await second.json() as { applied: boolean }).applied).toBe(false);
    });

    it('never reaches another account’s workspace of the same id', async () => {
      expect((await setCorrection('Ada’s own correction.', WORKSPACE_ID, OTHER_USER_ID)).status).toBe(200);

      // No row at all for this account's own ws-1 - nothing here ever wrote one.
      expect(await rowFor(ACCOUNT_NAME, WORKSPACE_ID)).toBeNull();
      expect((await rowFor(OTHER_ACCOUNT_NAME, WORKSPACE_ID))?.correction).toBe('Ada’s own correction.');
    });
  });

  /**
   * The read half, through the same snapshot every screen inside a workspace
   * reads from (architecture, "The read model") - a distinct query path from
   * the write cases above, and the one a settings screen actually renders
   * from.
   */
  describe('the workspace snapshot carries it', () => {
    async function snapshot(workspaceId = WORKSPACE_ID) {
      const response = await asUser(`http://cockpit.test/v1/workspaces/${workspaceId}/snapshot`);
      expect(response.status).toBe(200);
      return (await response.json()) as { routingSummary: unknown };
    }

    it('reads null where nothing has been generated or corrected yet', async () => {
      expect((await snapshot()).routingSummary).toBeNull();
    });

    it('reads back a correction just written, with no summary alongside it', async () => {
      await setCorrection('Sign-off questions go to Laurens.');

      expect((await snapshot()).routingSummary).toMatchObject({
        summary: null,
        correction: 'Sign-off questions go to Laurens.',
      });
    });

    it('reads back a summary the nightly job wrote, alongside a correction', async () => {
      await aStoredSummary('You file compliance questions to Compliance questions.');
      await setCorrection('Sign-off questions go to Laurens.');

      expect((await snapshot()).routingSummary).toMatchObject({
        summary: 'You file compliance questions to Compliance questions.',
        summaryGeneratedAt: '2026-09-09T03:00:00.000Z',
        correction: 'Sign-off questions go to Laurens.',
      });
    });
  });
});
