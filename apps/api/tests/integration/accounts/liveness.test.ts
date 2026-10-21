import { beforeEach, describe, expect, inject, it } from 'vitest';
import { applyD1Migrations, env, runInDurableObject } from 'cloudflare:test';
import { ACCOUNT_WIDE, rememberedSentenceListSchema, type RememberedSentenceList, type ServerEvent } from '@cockpit/shared';
import { createAccountDb } from '../../../src/accounts/client.js';
import { readingsSince } from '../../../src/accounts/events.js';
import {
  ACCOUNT_NAME,
  TASK_TYPE_ID,
  WORKSPACE_ID,
  alsoWorkspaces,
  asUser,
  inTheStore,
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

async function capture(workspaceId: string, message: string, workspaceDecided = true) {
  const res = await asUser('http://cockpit.test/v1/commands/capture_item', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      commandId: nextId(),
      issuedAt: '2026-09-08T10:00:00.000Z',
      workspaceId,
      itemId: nextId(),
      message,
      workspaceDecided,
    }),
  });
  expect(res.status).toBe(200);
}

/** A change to a remembered sentence, sent as the Settings window and the review window send it. */
async function changeSentence(name: string, payload: Record<string, unknown>) {
  const res = await asUser(`http://cockpit.test/v1/commands/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commandId: nextId(), issuedAt: '2026-10-21T10:00:00.000Z', ...payload }),
  });
  expect(res.status).toBe(200);
}

const A_SENTENCE = '018f3333-0000-7000-8000-000000000001';

/** The list of sentences as Settings reads it. */
async function sentenceList(): Promise<RememberedSentenceList> {
  const res = await asUser('http://cockpit.test/v1/remembered-sentences');
  expect(res.status).toBe(200);
  return rememberedSentenceListSchema.parse(await res.json());
}

const rememberASentence = () =>
  changeSentence('remember_sentence', {
    workspaceId: WORKSPACE_ID,
    sentenceId: A_SENTENCE,
    sentence: 'Sign as Michael.',
    action: 'reply to a mail',
    sourceKind: 'gmail',
  });

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

  describe('a remembered sentence is announced for the list of sentences, not for a workspace', () => {
    it.each([
      {
        situation: 'kept, even for a workspace it names',
        arrange: async () => {},
        change: rememberASentence,
      },
      {
        situation: 'reworded',
        arrange: rememberASentence,
        change: () =>
          changeSentence('edit_remembered_sentence', { workspaceId: ACCOUNT_WIDE, sentenceId: A_SENTENCE, sentence: 'Sign as M.' }),
      },
      {
        situation: 'deleted',
        arrange: rememberASentence,
        change: () => changeSentence('delete_remembered_sentence', { workspaceId: ACCOUNT_WIDE, sentenceId: A_SENTENCE }),
      },
    ])('a sentence $situation names the list and no workspace, and nothing is left behind it', async ({ arrange, change }) => {
      await arrange();
      const from = await fromNow();

      await change();
      const { events, cursor } = await changesSince(from);

      expect(events).toEqual([{ type: 'remembered_sentences_changed', at: expect.any(String) }]);
      expect((await changesSince(cursor)).events).toEqual([]);
    });

    it('stamps the announcement and the list of sentences with the same newest change', async () => {
      await rememberASentence();
      const from = await fromNow();
      await changeSentence('edit_remembered_sentence', { workspaceId: ACCOUNT_WIDE, sentenceId: A_SENTENCE, sentence: 'Sign as M.' });

      const { events } = await changesSince(from);
      const list = await sentenceList();

      const announced = events[0] as { at: string };
      expect(announced.at > from).toBe(true);
      expect(list.upTo).toBe(announced.at);
    });

    it('gives the list of sentences no stamp for an account that never changed one', async () => {
      expect((await sentenceList()).upTo).toBeUndefined();
    });

    it('still announces a note captured to Any workspace to the whole account', async () => {
      const from = await fromNow();

      await capture(WORKSPACE_ID, 'Not yet in a workspace', false);
      await rememberASentence();
      const { events } = await changesSince(from);

      expect(events).toHaveLength(2);
      expect(events).toContainEqual({ type: 'remembered_sentences_changed', at: expect.any(String) });
      expect(events).toContainEqual(expect.objectContaining({ type: 'snapshot_invalidated', workspaceId: ACCOUNT_WIDE }));
    });

    it('announces a workspace’s own change as before beside a sentence’s', async () => {
      const from = await fromNow();

      await rememberASentence();
      await capture(WORKSPACE_ID, 'In the first');
      const { events } = await changesSince(from);

      expect(events).toHaveLength(2);
      expect(events).toContainEqual({ type: 'remembered_sentences_changed', at: expect.any(String) });
      expect(events).toContainEqual(expect.objectContaining({ type: 'snapshot_invalidated', workspaceId: WORKSPACE_ID }));
    });
  });

  describe('checking for changes does not go through every note an account holds', () => {
    /**
     * Every open tab asks every three seconds, so what one check visits is paid
     * for by every tab of every account. The plan is the proof: which index a
     * real store answers from cannot be shown by a unit, and counting rows read
     * would only restate it. It plans the statement `collectInvalidations` runs
     * (`readingsSince`), not a copy.
     */
    it('looks only at the notes read since the last check', async () => {
      await inTheStore(() => undefined);
      const plan = await runInDurableObject(storeNamed(ACCOUNT_NAME), (_instance, state) => {
        const { sql, params } = readingsSince(
          createAccountDb(state.storage),
          ACCOUNT_NAME,
          '2026-09-08T00:00:00.000Z',
        ).toSQL();
        return state.storage.sql
          .exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...params)
          .toArray()
          .map((row) => row.detail);
      });

      expect(plan).toContainEqual(
        expect.stringMatching(/USING INDEX item_meanings_tenant_read_at \(tenant_id=\? AND read_at>\?\)/),
      );
    });
  });
});