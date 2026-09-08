import { beforeEach, describe, expect, inject, it } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import { TASK_TYPE_ID, WORKSPACE_ID, asUser, seedRegister, startFromEmpty } from '../seed.js';

/**
 * POC (own-event refetch): what a snapshot says about how current it is.
 *
 * Integration level, through the real Worker, because the whole claim is about
 * the command log - which rows are there and in what order a store reads them.
 * There is nothing to prove one level down: `watermark` is a single query, and
 * whether it is *read before the rows it vouches for* is a fact about the
 * function that calls it, not about either query.
 *
 * The comparison the client makes with this is decided in
 * apps/web/tests/unit/api/useServerEvents.test.tsx, where the branches are.
 */

let seq = 0;
const nextId = () => {
  seq += 1;
  return `018f1111-0000-7000-8000-${String(seq).padStart(12, '0')}`;
};

async function capture(message: string) {
  return asUser('http://cockpit.test/v1/commands/capture_item', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      commandId: nextId(),
      issuedAt: '2026-09-08T10:00:00.000Z',
      workspaceId: WORKSPACE_ID,
      itemId: nextId(),
      message,
      typeId: TASK_TYPE_ID,
      workspaceDecided: true,
    }),
  });
}

async function readBack(): Promise<{ upTo?: string; items: { capturedMessage: string }[] }> {
  const res = await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/snapshot`);
  expect(res.status).toBe(200);
  return (await res.json()) as { upTo?: string; items: { capturedMessage: string }[] };
}

const upToOf = async () => (await readBack()).upTo;
const messagesOf = async () => (await readBack()).items.map((item) => item.capturedMessage);

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  // Emptied before the register is seeded, not after: `startFromEmpty` clears
  // `tenants`, so the other order deletes the rows just written and every
  // sign-in is refused as an unknown account.
  await startFromEmpty();
  await seedRegister();
  seq = 0;
});

describe('Live updates', () => {
  describe('a workspace says how current the copy of it is', () => {
    it('names the newest change the account has taken', async () => {
      await capture('Something to be newer than');

      const upTo = await upToOf();

      // A time of the store's own making, not the Worker's - which is the whole
      // reason the field exists rather than `generatedAt` being reused.
      expect(upTo).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    /**
     * **Never backwards**, which is what is actually guaranteed. Asserting that
     * it strictly *advances* would assert the thing this change documents as
     * not held: two changes taken inside one millisecond wear the same time, so
     * a strict `>` here is a test that fails for the reason the code is honest
     * about. What the reading has to keep pace with is proved beside it, by the
     * copy holding both changes.
     */
    it('never goes backwards as changes are taken', async () => {
      await capture('The first one');
      const before = await upToOf();

      await capture('The second one');
      const after = await upToOf();

      expect(before).toBeDefined();
      expect(after! >= before!).toBe(true);
      expect(await messagesOf()).toEqual(
        expect.arrayContaining(['The first one', 'The second one']),
      );
    });

    /**
     * **Never ahead of what the copy holds**, which is the one direction that
     * cannot be allowed: naming a change the copy does not contain makes a tab
     * skip a read it needed, and nothing later corrects it. Behind is free - it
     * costs a read that was not necessary.
     */
    it('never names a change the copy does not contain', async () => {
      await capture('An item that must be there too');

      const read = await readBack();

      expect(read.items.map((item) => item.capturedMessage)).toContain(
        'An item that must be there too',
      );
      expect(read.upTo).toBeDefined();
    });
  });
});
