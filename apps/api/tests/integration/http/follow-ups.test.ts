import { beforeEach, describe, expect, inject, it } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import { ACCOUNT_WIDE, type CommandName, type Item, type WorkspaceSnapshot } from '@cockpit/shared';
import {
  ACCOUNT_NAME,
  OTHER_USER_ID,
  WORKSPACE_ID,
  alsoWorkspaces,
  asUser,
  inStoreAsItIs,
  seedRegister,
  signInAs,
  startFromEmpty,
  storeNamed,
} from '../seed.js';

/**
 * Integration level, through the real Worker: the number Settings › Follow-ups
 * keeps is a row in the account's store, read into every Workspace
 * ("Choose in Settings how many days to wait for a reply", issue 1465), so it
 * only holds against the real store. Where the section and the question draw
 * it is apps/web/tests/unit/components/ManageFollowUps.test.tsx and
 * WaitForReply.test.tsx.
 */

let seq = 0;
function nextId(): string {
  seq += 1;
  return `018f0000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
}

const AT = '2082-10-22T10:00:00.000Z';

function post(name: CommandName, payload: Record<string, unknown>, userId?: string) {
  return asUser(
    `http://cockpit.test/v1/commands/${name}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: nextId(), issuedAt: AT, ...payload }),
    },
    userId,
  );
}

const choose = (days: unknown, userId?: string) => post('set_follow_up_days', { workspaceId: ACCOUNT_WIDE, days }, userId);

async function read(workspaceId: string = WORKSPACE_ID, userId?: string): Promise<WorkspaceSnapshot> {
  const response = await asUser(`http://cockpit.test/v1/workspaces/${workspaceId}/snapshot`, undefined, userId);
  expect(response.status).toBe(200);
  return (await response.json()) as WorkspaceSnapshot;
}

/** The account's row, brought up to date first so a store nothing has opened has the table to read. */
async function rowsFor(accountName: string) {
  const opened = await storeNamed(accountName).workspaces(accountName);
  if (opened.status !== 'ok') throw new Error(JSON.stringify(opened));
  return inStoreAsItIs(accountName, (sql) => sql.exec('SELECT tenant_id, days FROM account_follow_ups').toArray());
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  await signInAs();
  await signInAs(OTHER_USER_ID);
  seq = 0;
});

describe('Triage', () => {
  describe('the days Wait for reply starts on are a whole number from 1 to 365 kept for the whole account, and 3 until chosen', () => {
    it('reads 3 for an account that has never chosen, with nothing written for it', async () => {
      expect((await read()).followUpDays).toBe(3);
      expect(await rowsFor(ACCOUNT_NAME)).toEqual([]);
    });

    it('reads the number chosen in every Workspace of the account', async () => {
      await alsoWorkspaces();

      expect((await choose(7)).status).toBe(200);

      const read7 = await Promise.all([WORKSPACE_ID, 'ws-atlas', 'ws-personal'].map((id) => read(id)));
      expect(read7.map((snapshot) => snapshot.followUpDays)).toEqual([7, 7, 7]);
    });

    it('a second choice replaces the first, on the same row', async () => {
      await choose(7);

      expect((await choose(14)).status).toBe(200);

      expect((await read()).followUpDays).toBe(14);
      expect(await rowsFor(ACCOUNT_NAME)).toEqual([{ tenant_id: ACCOUNT_NAME, days: 14 }]);
    });

    it.each([
      { situation: 'none', days: 0 },
      { situation: 'more than a year', days: 366 },
      { situation: 'part of a day', days: 2.5 },
      { situation: 'words', days: 'seven' },
    ])('refuses $situation and keeps nothing', async ({ days }) => {
      const response = await choose(days);

      expect(response.status).toBe(400);
      expect((await read()).followUpDays).toBe(3);
      expect(await rowsFor(ACCOUNT_NAME)).toEqual([]);
    });

    it('a choice sent twice is kept once', async () => {
      const body = JSON.stringify({ commandId: nextId(), issuedAt: AT, workspaceId: ACCOUNT_WIDE, days: 7 });
      const once = () =>
        asUser('http://cockpit.test/v1/commands/set_follow_up_days', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        });

      expect((await once()).status).toBe(200);
      const second = await once();

      expect(second.status).toBe(200);
      expect(((await second.json()) as { applied: boolean }).applied).toBe(false);
      expect(await rowsFor(ACCOUNT_NAME)).toEqual([{ tenant_id: ACCOUNT_NAME, days: 7 }]);
    });

    it('is the account’s own, never read from or written to another account’s', async () => {
      expect((await choose(7, OTHER_USER_ID)).status).toBe(200);

      expect((await read()).followUpDays).toBe(3);
      expect(await rowsFor(ACCOUNT_NAME)).toEqual([]);
    });
  });

  describe('changing the days Wait for reply starts on moves no due date already given', () => {
    it('leaves an Item already waiting due on the day it was given', async () => {
      const itemId = nextId();
      await post('capture_item', { workspaceId: WORKSPACE_ID, itemId, message: 'Reply from Jan about the audit trail' });
      await post('wait_for_reply', { workspaceId: WORKSPACE_ID, itemId, days: 3, timeZone: 'UTC' });
      const before = (await read()).items.find((item) => item.id === itemId) as Item;
      expect(before).toMatchObject({ dueDate: '2082-10-25', waitingSince: AT });

      expect((await choose(7)).status).toBe(200);

      expect((await read()).items.find((item) => item.id === itemId)).toEqual(before);
    });
  });
});
