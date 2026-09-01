import { beforeEach, describe, expect, inject, it } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import { OTHER_USER_ID, USER_ID, asUser, seedRegister, startFromEmpty } from '../seed.js';

/**
 * Integration level, through the real Worker, and this is the one rule that
 * genuinely needs two of everything: two people, two accounts, two stores. What
 * is being claimed is that the account a request resolves is the account of
 * whoever sent it, and no arrangement with a single account can tell that apart
 * from "there is only one account to resolve".
 *
 * Every case makes what it looks for. The two accounts start out identical -
 * both are given the same starting workspaces the first time they are opened -
 * so a case that asserted on the seed would be asserting on a coincidence
 * rather than on the boundary.
 */

const AT = '2026-09-01T10:00:00.000Z';

let seq = 0;
function nextId(): string {
  seq += 1;
  return `018f0000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
}

async function makeWorkspace(userId: string, name: string): Promise<string> {
  const workspaceId = nextId();
  const res = await asUser(
    'http://cockpit.test/v1/commands/create_workspace',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: nextId(), issuedAt: AT, workspaceId, name }),
    },
    userId,
  );
  expect(res.status).toBe(200);
  return workspaceId;
}

async function captureThought(userId: string, workspaceId: string, title: string): Promise<void> {
  const res = await asUser(
    'http://cockpit.test/v1/commands/capture_item',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        commandId: nextId(),
        issuedAt: AT,
        workspaceId,
        itemId: nextId(),
        title,
      }),
    },
    userId,
  );
  expect(res.status).toBe(200);
}

async function workspaceNames(userId: string): Promise<string[]> {
  const res = await asUser('http://cockpit.test/v1/workspaces', {}, userId);
  expect(res.status).toBe(200);
  const { workspaces } = (await res.json()) as { workspaces: { name: string }[] };
  return workspaces.map((w) => w.name);
}

async function thoughtsIn(userId: string, workspaceId: string): Promise<string[]> {
  const res = await asUser(`http://cockpit.test/v1/workspaces/${workspaceId}/snapshot`, {}, userId);
  expect(res.status).toBe(200);
  const { items } = (await res.json()) as { items: { title: string }[] };
  return items.map((i) => i.title);
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  seq = 0;
});

describe('Accounts', () => {
  describe('you see your own account and no one else’s', () => {
    it('lists the workspaces you made and none of the other person’s', async () => {
      await makeWorkspace(USER_ID, 'Bookkeeping');
      await makeWorkspace(OTHER_USER_ID, 'Choir');

      expect(await workspaceNames(USER_ID)).toContain('Bookkeeping');
      expect(await workspaceNames(USER_ID)).not.toContain('Choir');
      expect(await workspaceNames(OTHER_USER_ID)).toContain('Choir');
      expect(await workspaceNames(OTHER_USER_ID)).not.toContain('Bookkeeping');
    });

    it('cannot open a workspace belonging to the other account', async () => {
      const mine = await makeWorkspace(USER_ID, 'Bookkeeping');

      const res = await asUser(
        `http://cockpit.test/v1/workspaces/${mine}/snapshot`,
        {},
        OTHER_USER_ID,
      );

      // Not found, rather than refused: from the other account that workspace
      // does not exist, and saying anything else would confirm that it does.
      expect(res.status).toBe(404);
    });

    it('does not show a thought captured by the other person', async () => {
      const mine = await makeWorkspace(USER_ID, 'Bookkeeping');
      const theirs = await makeWorkspace(OTHER_USER_ID, 'Choir');
      await captureThought(USER_ID, mine, 'Reconcile the quarter');

      expect(await thoughtsIn(USER_ID, mine)).toEqual(['Reconcile the quarter']);
      expect(await thoughtsIn(OTHER_USER_ID, theirs)).toEqual([]);
    });
  });
});
