import { beforeEach, describe, expect, inject, it } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import { ACCOUNT_WIDE } from '@cockpit/shared';
import type { WorkspaceSnapshot } from '@cockpit/shared';
import {
  ACCOUNT_NAME,
  OTHER_USER_ID,
  WORKSPACE_ID,
  asUser,
  inStoreAsItIs,
  seedRegister,
  signInAs,
  startFromEmpty,
  storeNamed,
} from '../seed.js';

/**
 * Integration level, through the real Worker (`asUser`), for the reason
 * `text-learning-rules.test.ts` beside this file is: whether the choice
 * lands, and who it is scoped to, is a fact about the store, not about a pure
 * function ("Let the item's form dock to the side of the screen instead of
 * opening as a dialog", issue 481).
 */

let seq = 0;
function nextId(): string {
  seq += 1;
  return `018f0000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
}

const AT = '2026-09-18T10:00:00.000Z';

async function setPresentation(presentation: 'centered' | 'docked', userId?: string) {
  return asUser(
    'http://cockpit.test/v1/commands/set_item_form_presentation',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        commandId: nextId(),
        issuedAt: AT,
        workspaceId: ACCOUNT_WIDE,
        presentation,
      }),
    },
    userId,
  );
}

/** What the workspace's own snapshot reads the choice as - the only place a client ever reads it. */
async function presentationInSnapshot(userId?: string): Promise<string> {
  const response = await asUser(
    `http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/snapshot`,
    undefined,
    userId,
  );
  expect(response.status).toBe(200);
  const snapshot = (await response.json()) as WorkspaceSnapshot;
  return snapshot.itemFormPresentation;
}

/**
 * Brought up to date first, unlike a bare `inStoreAsItIs` - a store nothing
 * has opened yet has no `account_item_form_presentation` table at all
 * (`accounts/changes.ts`), which the "never chosen" case here reads before
 * ever sending a command that would open it.
 */
async function rowFor(accountName: string) {
  const opened = await storeNamed(accountName).workspaces(accountName);
  if (opened.status !== 'ok') throw new Error(JSON.stringify(opened));
  const rows = await inStoreAsItIs(accountName, (sql) =>
    sql
      .exec<{ presentation: string | null }>(
        'SELECT presentation FROM account_item_form_presentation WHERE tenant_id = ?',
        accountName,
      )
      .toArray(),
  );
  return rows[0] ?? null;
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  await signInAs();
  await signInAs(OTHER_USER_ID);
  seq = 0;
});

describe('Item editing', () => {
  describe('the account remembers one of two presentations for the item’s form, defaulting to centered', () => {
    it('reads centered for an account that has never chosen, with no row written for it', async () => {
      expect(await rowFor(ACCOUNT_NAME)).toBeNull();

      expect(await presentationInSnapshot()).toBe('centered');
    });

    it('reads back docked once chosen', async () => {
      expect((await setPresentation('docked')).status).toBe(200);

      expect(await presentationInSnapshot()).toBe('docked');
    });

    it('switching back reads centered again, on the same row rather than a second one', async () => {
      await setPresentation('docked');

      expect((await setPresentation('centered')).status).toBe(200);

      expect(await presentationInSnapshot()).toBe('centered');
      const rows = await inStoreAsItIs(ACCOUNT_NAME, (sql) =>
        sql.exec('SELECT * FROM account_item_form_presentation').toArray(),
      );
      expect(rows).toHaveLength(1);
    });

    it('is refused for anything other than the two known presentations', async () => {
      const response = await asUser('http://cockpit.test/v1/commands/set_item_form_presentation', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          commandId: nextId(),
          issuedAt: AT,
          workspaceId: ACCOUNT_WIDE,
          presentation: 'floating',
        }),
      });

      expect(response.status).not.toBe(200);
      expect(await rowFor(ACCOUNT_NAME)).toBeNull();
    });

    it('writes the choice once, not twice, when the same command is replayed', async () => {
      const body = {
        commandId: nextId(),
        issuedAt: AT,
        workspaceId: ACCOUNT_WIDE,
        presentation: 'docked',
      };
      const once = () =>
        asUser('http://cockpit.test/v1/commands/set_item_form_presentation', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });

      const first = await once();
      const second = await once();

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(((await second.json()) as { applied: boolean }).applied).toBe(false);
    });

    it('is the account’s own, never read from or written to another account’s choice', async () => {
      expect((await setPresentation('docked', OTHER_USER_ID)).status).toBe(200);

      expect(await presentationInSnapshot()).toBe('centered');
      expect(await presentationInSnapshot(OTHER_USER_ID)).toBe('docked');
      expect(await rowFor(ACCOUNT_NAME)).toBeNull();
    });
  });
});
