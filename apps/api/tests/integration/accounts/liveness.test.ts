import { beforeEach, describe, expect, inject, it } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import type { ServerEvent } from '@cockpit/shared';
import {
  ACCOUNT_NAME,
  TASK_TYPE_ID,
  WORKSPACE_ID,
  alsoWorkspaces,
  asUser,
  seedRegister,
  startFromEmpty,
  storeNamed,
} from '../seed.js';

/**
 * What the store hands the stream when it is asked what has changed.
 *
 * Integration level, and it could be nothing else: what is under test is which
 * rows the query finds and which of them each answer speaks for, neither of
 * which holds anywhere but against a real store. Asked of `changesSince`
 * directly rather than through `/v1/events`, because the endpoint's own job is
 * to hold a connection open and poll - a test driving it would be measuring the
 * three-second sleep, and would prove nothing about the grouping that this
 * does not.
 *
 * The wire's side of the same feature - a workspace saying how current the copy
 * of it is - is in tests/integration/http/liveness.test.ts.
 */

let seq = 0;
const nextId = () => {
  seq += 1;
  return `018f2222-0000-7000-8000-${String(seq).padStart(12, '0')}`;
};

async function capture(workspaceId: string, message: string) {
  const res = await asUser('http://cockpit.test/v1/commands/capture_item', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      commandId: nextId(),
      issuedAt: '2026-09-08T10:00:00.000Z',
      workspaceId,
      itemId: nextId(),
      message,
      typeId: TASK_TYPE_ID,
      workspaceDecided: true,
    }),
  });
  expect(res.status).toBe(200);
}

async function changesSince(since: string): Promise<{ events: ServerEvent[]; cursor: string }> {
  const answer = await storeNamed(ACCOUNT_NAME).changesSince(ACCOUNT_NAME, since);
  expect(answer).toMatchObject({ status: 'ok' });
  return (answer as { status: 'ok'; value: { events: ServerEvent[]; cursor: string } }).value;
}

/** When the changes below start from: everything already there is older than this. */
async function fromNow(): Promise<string> {
  return (await changesSince('2026-09-08T00:00:00.000Z')).cursor;
}

function whenIt(events: ServerEvent[], workspaceId: string): string | undefined {
  for (const event of events) {
    if (event.type === 'snapshot_invalidated' && event.workspaceId === workspaceId) return event.at;
  }
  return undefined;
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  await alsoWorkspaces();
  seq = 0;
});

describe('Live updates', () => {
  describe('what a tab is told has changed', () => {
    it('speaks once for a workspace however many changes it took', async () => {
      const from = await fromNow();
      await capture(WORKSPACE_ID, 'One');
      await capture(WORKSPACE_ID, 'Two');
      await capture(WORKSPACE_ID, 'Three');

      const { events } = await changesSince(from);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: 'snapshot_invalidated', workspaceId: WORKSPACE_ID });
    });

    it('speaks for each workspace that changed, and no others', async () => {
      const from = await fromNow();
      await capture(WORKSPACE_ID, 'In the first');
      await capture('ws-atlas', 'In the second');

      const { events } = await changesSince(from);

      expect(
        events.map((event) => (event.type === 'snapshot_invalidated' ? event.workspaceId : '')),
      ).toEqual(expect.arrayContaining([WORKSPACE_ID, 'ws-atlas']));
      expect(events).toHaveLength(2);
    });

    /**
     * **The newest of them, not the first.** This is what a tab compares its own
     * copy against, so naming the older of two changes would tell a tab that
     * already held the newer one to read again - and, worse, would leave the
     * newer change unaccounted for by anything the tab was told.
     *
     * Asked by starting again from the answer rather than by comparing clocks:
     * if it named the first change, the second would still be waiting there.
     * That also makes it indifferent to two changes sharing a millisecond,
     * which is the one thing this reading cannot currently promise.
     */
    it('names the newest of a workspace\'s changes, leaving nothing behind it', async () => {
      const from = await fromNow();
      await capture(WORKSPACE_ID, 'The earlier one');
      await capture(WORKSPACE_ID, 'The later one');

      const { events } = await changesSince(from);
      const nothingLeft = await changesSince(whenIt(events, WORKSPACE_ID)!);

      expect(nothingLeft.events).toEqual([]);
    });
  });
});
