import { beforeEach, describe, expect, inject, it } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import type { WorkspaceSnapshot } from '@cockpit/shared';
import {
  ACCOUNT_NAME,
  DASHBOARD_ID,
  OTHER_ACCOUNT_NAME,
  WORKSPACE_ID,
  alsoWorkspaces,
  asUser,
  inTheStore,
  seedRegister,
  startFromEmpty,
} from '../seed.js';

/**
 * Integration level, and it could be nothing else: what is under test is which
 * rows a snapshot's query reaches, and a scope is only a scope against a real
 * store with more than one workspace in it ("Give the account a list of screen
 * sizes, before anything reads it", issue 262).
 *
 * **Written straight into the store**, which is the exception the testing skill
 * allows for a rule the real interface cannot reach: no command writes a screen
 * size until "Draw a dashboard against the screen sizes its account has" (issue
 * 263), and the point of this release is that the read path is already there
 * when it does.
 */

const AT = '2026-08-12T10:00:00.000Z';

async function putScreenSize(
  size: { id: string; name: string; width: number },
  tenantId: string = ACCOUNT_NAME,
): Promise<void> {
  await inTheStore((sql) => {
    sql.exec(
      `INSERT INTO screen_sizes (id, tenant_id, name, folded_name, width, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      size.id,
      tenantId,
      size.name,
      size.name.toLowerCase(),
      size.width,
      AT,
    );
  });
}

async function snapshotOf(workspaceId: string): Promise<WorkspaceSnapshot> {
  const response = await asUser(`http://cockpit.test/v1/workspaces/${workspaceId}/snapshot`);
  expect(response.status).toBe(200);
  return (await response.json()) as WorkspaceSnapshot;
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
});

describe('Layouts', () => {
  describe('a screen size belongs to the account, not to a dashboard or a workspace', () => {
    it('is offered in every workspace the account has, from one row', async () => {
      // The whole point of the split: a layout carried its own name and width,
      // so every dashboard re-declared the same screens.
      await alsoWorkspaces();
      await putScreenSize({ id: 'sz-wide', name: 'Wide', width: 1280 });

      const here = await snapshotOf(WORKSPACE_ID);
      const elsewhere = await snapshotOf('ws-atlas');

      expect(here.screenSizes).toEqual([
        { id: 'sz-wide', tenantId: ACCOUNT_NAME, name: 'Wide', width: 1280, createdAt: AT },
      ]);
      expect(elsewhere.screenSizes).toEqual(here.screenSizes);
    });

    it('is offered narrowest first, which is the order they are read in', async () => {
      await putScreenSize({ id: 'sz-wide', name: 'Wide', width: 1280 });
      await putScreenSize({ id: 'sz-phone', name: 'Phone', width: 430 });
      await putScreenSize({ id: 'sz-tablet', name: 'Tablet', width: 800 });

      const snapshot = await snapshotOf(WORKSPACE_ID);

      expect(snapshot.screenSizes.map((size) => size.name)).toEqual(['Phone', 'Tablet', 'Wide']);
    });

    it('is never another account’s, which is what tenant_id is for', async () => {
      await putScreenSize({ id: 'sz-theirs', name: 'Theirs', width: 1280 }, OTHER_ACCOUNT_NAME);

      const snapshot = await snapshotOf(WORKSPACE_ID);

      expect(snapshot.screenSizes).toEqual([]);
    });

    it('is an empty list where the account has none, which is every account until issue 263', async () => {
      const snapshot = await snapshotOf(WORKSPACE_ID);

      expect(snapshot.screenSizes).toEqual([]);
    });
  });

  describe('a layout says which screen size it is for, or that it is for none', () => {
    it('comes back naming no size, which is every layout until issue 263', async () => {
      // The other half of the shape this release changes, and it needs saying
      // out loud: `layoutSchema` defaults `screenSizeId` to null, so a read
      // path that stopped selecting the column would leave every case above
      // green and only be found once something wrote a value and never got it
      // back.
      await inTheStore((sql) => {
        sql.exec(
          `INSERT INTO layouts (id, tenant_id, dashboard_id, name, folded_name, screen_width, created_at)
           VALUES ('lay-1', ?, ?, 'Wide', 'wide', 1280, ?)`,
          ACCOUNT_NAME,
          DASHBOARD_ID,
          AT,
        );
      });

      const snapshot = await snapshotOf(WORKSPACE_ID);

      expect(snapshot.layouts).toEqual([
        expect.objectContaining({ id: 'lay-1', screenSizeId: null }),
      ]);
    });
  });
});
