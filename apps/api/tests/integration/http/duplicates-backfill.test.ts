import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import { SELF, applyD1Migrations, env } from 'cloudflare:test';
import type { CommandName, CommandPayload, PossibleDuplicate } from '@cockpit/shared';
import {
  ACCOUNT_NAME,
  OTHER_ACCOUNT_NAME,
  OTHER_USER_ID,
  USER_ID,
  WORKSPACE_ID,
  accountOf,
  alsoWorkspaces,
  asUser,
  inStoreAsItIs,
  seedRegister,
  signInAs,
  startFromEmpty,
  taskTypeIn,
} from '../seed.js';
import { EMBEDDING_MODEL } from '../../../src/embeddings/index.js';

/**
 * "Give every item already there a vector" (issue 409): the operator's command
 * that reads the notes which were already in the Inbox when duplicate flagging
 * shipped.
 *
 * Integration level throughout: a real store, a real schema and the real Worker
 * (`SELF.fetch`), so the operator's gate, the route and the store's own
 * transaction all run. What is faked is the one horizontal dependency - what
 * reads meaning, at the binding - exactly as `duplicate-notes.test.ts` fakes it
 * next door.
 *
 * **Which rows are picked up cannot be asked lower down**: it is one query with
 * four complementary filters over the account's own tables, and being resumable
 * is a property of the rows a previous call left behind. What the command
 * *decides* - how its flags are read, how far it walks, what it says when it
 * stops - is scripts/lib/duplicates-backfill.test.mjs's and is not asked again
 * here.
 */

const SECRET = 'test-operator-secret';

/** Two notes about Novy and one about the shopping - the second being what "not a duplicate" looks like. */
const A_NOTE = 'part 11 audit trail question for novy';
const THE_SAME_AGAIN = 'novy, and the audit trail on part 11';
const SOMETHING_ELSE = 'buy milk on the way home';

const MEANINGS: Record<string, number[]> = {
  novy: [1, 0],
  milk: [0, 1],
};

/** Every text the reader was given, in order - what says a run cost nothing for what was done. */
let read: string[] = [];

function readingOf(text: string): number[] {
  const found = Object.entries(MEANINGS).find(([word]) => text.toLowerCase().includes(word));
  // Refused rather than fallen back on, for the reason duplicate-notes.test.ts
  // gives: a fallback is a reading two unrelated notes would share, which is
  // the answer half of these cases assert the absence of.
  if (!found) throw new Error(`this case did not say what "${text}" means`);
  return found[1];
}

function somethingCanReadMeaning(): void {
  (env as unknown as { AI: unknown }).AI = {
    run: async (_model: string, input: { text: string[] }) => {
      const text = input.text[0]!;
      read.push(text);
      return { data: [readingOf(text)] };
    },
  };
}

/** The state this whole file is about: notes already in the Inbox that nothing has read. */
function nothingCanReadMeaning(): void {
  Reflect.deleteProperty(env as unknown as Record<string, unknown>, 'AI');
}

let seq = 0;
function nextId(): string {
  seq += 1;
  return `018f0000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
}

async function postChange<N extends CommandName>(
  name: N,
  payload: CommandPayload<N>,
  userId?: string,
) {
  const response = await asUser(
    `http://cockpit.test/v1/commands/${name}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    },
    userId,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return response;
}

/** A note captured where nothing could read it - the only kind this file arranges. */
async function aNoteNobodyRead(
  message: string,
  overrides: Partial<CommandPayload<'capture_item'>> = {},
  userId?: string,
): Promise<string> {
  const itemId = overrides.itemId ?? nextId();
  const account = accountOf(userId ?? USER_ID);
  await postChange(
    'capture_item',
    {
      commandId: nextId(),
      issuedAt: '2026-09-09T10:00:00.000Z',
      workspaceId: WORKSPACE_ID,
      itemId,
      message,
      typeId: taskTypeIn(account),
      ...overrides,
    },
    userId,
  );
  return itemId;
}

/** What one call of `pnpm duplicates:backfill` asks of one account. */
interface Batch {
  account: string;
  read: string[];
  couldNotBeRead: string[];
  wentAway: string[];
  lastLooked: string | null;
  more: boolean;
}

async function backfillOnce(
  accountName: string = ACCOUNT_NAME,
  query: { after?: string | null; batch?: number | undefined } = {},
): Promise<Batch> {
  const response = await asking(accountName, query);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Batch;
}

function asking(
  accountName: string,
  { after, batch }: { after?: string | null; batch?: number | undefined } = {},
): Promise<Response> {
  const asked = new URLSearchParams();
  if (after) asked.set('after', after);
  if (batch !== undefined) asked.set('batch', String(batch));
  const query = asked.toString();
  return SELF.fetch(
    `http://cockpit.test/v1/operator/duplicates/accounts/${encodeURIComponent(accountName)}${query ? `?${query}` : ''}`,
    { method: 'POST', headers: { authorization: `Bearer ${SECRET}` } },
  );
}

/** The whole walk the command does: batch after batch until there is no more. */
async function backfill(accountName: string = ACCOUNT_NAME, batch?: number): Promise<Batch[]> {
  const batches: Batch[] = [];
  let after: string | null = null;
  for (;;) {
    const one: Batch = await backfillOnce(accountName, { after, batch });
    batches.push(one);
    after = one.lastLooked;
    if (!one.more) return batches;
  }
}

/** What the Workspace's own snapshot says about which of its notes repeat which. */
async function duplicatesIn(
  workspaceId = WORKSPACE_ID,
  userId?: string,
): Promise<PossibleDuplicate[]> {
  const response = await asUser(
    `http://cockpit.test/v1/workspaces/${workspaceId}/snapshot`,
    {},
    userId,
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { duplicates: PossibleDuplicate[] }).duplicates;
}

/** A pair as the store keeps it: the smaller id first, whichever was read last. */
function pair(one: string, other: string): PossibleDuplicate {
  return one < other ? { itemId: one, otherItemId: other } : { itemId: other, otherItemId: one };
}

function storedAs(pairs: readonly PossibleDuplicate[]): unknown[] {
  return pairs.map((one) => ({ item_id: one.itemId, other_item_id: one.otherItemId }));
}

async function rowsIn(
  table: 'item_meanings' | 'item_duplicates' | 'duplicate_settlements',
  accountName: string = ACCOUNT_NAME,
): Promise<unknown[]> {
  return inStoreAsItIs(accountName, (sql) =>
    sql
      .exec(
        table === 'item_meanings'
          ? 'SELECT item_id, reading FROM item_meanings ORDER BY item_id'
          : table === 'item_duplicates'
            ? 'SELECT item_id, other_item_id FROM item_duplicates ORDER BY item_id, other_item_id'
            : 'SELECT item_id, other_item_id FROM duplicate_settlements ORDER BY item_id, other_item_id',
      )
      .toArray(),
  );
}

/** Which Items have a reading that says something, in id order. */
async function itemsWithAMeaning(accountName: string = ACCOUNT_NAME): Promise<string[]> {
  const rows = (await rowsIn('item_meanings', accountName)) as {
    item_id: string;
    reading: string;
  }[];
  return rows.filter((row) => row.reading !== '[]').map((row) => row.item_id);
}

/** Every row of `items`, whole - what a run may not have touched. */
async function everyItemRow(accountName: string = ACCOUNT_NAME): Promise<unknown[]> {
  return inStoreAsItIs(accountName, (sql) =>
    sql.exec('SELECT * FROM items ORDER BY id').toArray(),
  );
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  read = [];
  await signInAs();
  await signInAs(OTHER_USER_ID);
  // Every case starts from an Inbox nothing has read, which is the state this
  // whole command exists for.
  nothingCanReadMeaning();
});

afterEach(() => {
  nothingCanReadMeaning();
  env.EMBEDDINGS_STAND_IN = '';
  env.ANTHROPIC_API_KEY = '';
});

describe('Triage', () => {
  describe('every note already in the inbox is read, and one with nothing written on it is counted rather than passed over', () => {
    it.each([
      {
        situation: 'a title and a description',
        arrange: async () => {
          const itemId = await aNoteNobodyRead(A_NOTE);
          await postChange('set_description', {
            commandId: nextId(),
            issuedAt: '2026-09-09T10:05:00.000Z',
            workspaceId: WORKSPACE_ID,
            itemId,
            description: 'novy asked about it again',
          });
          return itemId;
        },
        expected: 'read' as const,
      },
      {
        situation: 'a title and nothing else',
        arrange: () => aNoteNobodyRead(A_NOTE),
        expected: 'read' as const,
      },
      {
        situation: 'nothing written on it at all',
        arrange: async () => {
          const itemId = await aNoteNobodyRead(A_NOTE);
          await postChange('set_title', {
            commandId: nextId(),
            issuedAt: '2026-09-09T10:05:00.000Z',
            workspaceId: WORKSPACE_ID,
            itemId,
            title: '   ',
          });
          return itemId;
        },
        expected: 'counted, and never read' as const,
      },
      {
        situation: 'a note finished with',
        arrange: async () => {
          const itemId = await aNoteNobodyRead(A_NOTE);
          await postChange('set_done', {
            commandId: nextId(),
            issuedAt: '2026-09-09T10:05:00.000Z',
            workspaceId: WORKSPACE_ID,
            itemId,
            done: true,
          });
          return itemId;
        },
        expected: 'left alone' as const,
      },
      {
        situation: 'a note dismissed, which is what deleting one does',
        arrange: async () => {
          const itemId = await aNoteNobodyRead(A_NOTE);
          await postChange('set_dismissed', {
            commandId: nextId(),
            issuedAt: '2026-09-09T10:05:00.000Z',
            workspaceId: WORKSPACE_ID,
            itemId,
            dismissed: true,
          });
          return itemId;
        },
        expected: 'left alone' as const,
      },
    ])('$situation is $expected', async ({ arrange, expected }) => {
      const itemId = await arrange();
      somethingCanReadMeaning();

      const [batch] = await backfill();

      expect(batch!.read).toEqual(expected === 'read' ? [itemId] : []);
      expect(batch!.couldNotBeRead).toEqual(expected === 'counted, and never read' ? [itemId] : []);
      expect(await itemsWithAMeaning()).toEqual(expected === 'read' ? [itemId] : []);
      // Nothing was spent on the ones that are not read, which is half of what
      // picking them out of the query rather than out of the answer is for.
      expect(read).toHaveLength(expected === 'read' ? 1 : 0);
    });

    it('reads what the note shows, which is its title and its description together', async () => {
      const itemId = await aNoteNobodyRead(A_NOTE);
      await postChange('set_description', {
        commandId: nextId(),
        issuedAt: '2026-09-09T10:05:00.000Z',
        workspaceId: WORKSPACE_ID,
        itemId,
        description: 'novy asked about it again',
      });
      somethingCanReadMeaning();

      await backfill();

      expect(read).toEqual([`${A_NOTE}\n\nnovy asked about it again`]);
    });

    it('reads the rest of the inbox even where one note has nothing written on it', async () => {
      const blank = await aNoteNobodyRead(A_NOTE);
      await postChange('set_title', {
        commandId: nextId(),
        issuedAt: '2026-09-09T10:05:00.000Z',
        workspaceId: WORKSPACE_ID,
        itemId: blank,
        title: '   ',
      });
      const one = await aNoteNobodyRead(A_NOTE);
      const other = await aNoteNobodyRead(THE_SAME_AGAIN);
      somethingCanReadMeaning();

      const [batch] = await backfill();

      expect(batch!.couldNotBeRead).toEqual([blank]);
      expect(batch!.read).toEqual([one, other]);
      expect(await duplicatesIn()).toEqual([pair(one, other)]);
    });
  });

  describe('running it again finishes what was left and costs nothing for what was already read', () => {
    it('reads nothing the second time over the same account', async () => {
      await aNoteNobodyRead(A_NOTE);
      await aNoteNobodyRead(THE_SAME_AGAIN);
      somethingCanReadMeaning();
      await backfill();
      const readTheFirstTime = [...read];
      const paired = await rowsIn('item_duplicates');

      const again = await backfill();

      expect(read).toEqual(readTheFirstTime);
      expect(again.flatMap((batch) => batch.read)).toEqual([]);
      expect(await rowsIn('item_duplicates')).toEqual(paired);
    });

    it('reads the rest where a run stopped part way through', async () => {
      const one = await aNoteNobodyRead(A_NOTE);
      const other = await aNoteNobodyRead(THE_SAME_AGAIN);
      somethingCanReadMeaning();

      // One note and then nothing more - a run that was stopped, or a day's
      // allocation spent.
      const stopped = await backfillOnce(ACCOUNT_NAME, { batch: 1 });
      expect(stopped.read).toEqual([one]);
      expect(stopped.more).toBe(true);
      expect(await duplicatesIn()).toEqual([]);

      // Run again from the beginning, exactly as the command would be.
      const rest = await backfill();

      expect(rest.flatMap((batch) => batch.read)).toEqual([other]);
      expect(read).toEqual([A_NOTE, THE_SAME_AGAIN]);
      expect(await duplicatesIn()).toEqual([pair(one, other)]);
    });

    /**
     * Pairs are worked out from the readings rather than written once, which is
     * what makes a reading nothing was ever compared against repair itself: the
     * next note that matches it writes the pair from both readings, and the one
     * already read is not read again.
     */
    it('works out the pairs of a reading that has none, without reading that note again', async () => {
      const alreadyRead = await aNoteNobodyRead(A_NOTE);
      const other = await aNoteNobodyRead(THE_SAME_AGAIN);
      // A reading with no pair beside it - what an interruption between the two
      // tables, or a release that wrote one and not the other, would leave.
      await inStoreAsItIs(ACCOUNT_NAME, (sql) =>
        sql.exec(
          'INSERT INTO item_meanings (item_id, tenant_id, model, reading, read_at) VALUES (?, ?, ?, ?, ?)',
          alreadyRead,
          ACCOUNT_NAME,
          EMBEDDING_MODEL,
          JSON.stringify(MEANINGS.novy),
          '2026-09-09T10:00:00.000Z',
        ),
      );
      expect(await rowsIn('item_duplicates')).toEqual([]);
      somethingCanReadMeaning();

      await backfill();

      expect(await rowsIn('item_duplicates')).toEqual(storedAs([pair(alreadyRead, other)]));
      // The note that already had a reading cost nothing.
      expect(read).toEqual([THE_SAME_AGAIN]);
    });

    /**
     * A note emptied and then written again has a reading that says nothing
     * (`forgetMeaning`, accounts/repo.ts), which is a reading nothing can be
     * compared against - so it is one of the three states this reads as unread.
     */
    it('reads a note again whose reading was emptied when its texts were', async () => {
      const itemId = await aNoteNobodyRead(A_NOTE);
      await inStoreAsItIs(ACCOUNT_NAME, (sql) =>
        sql.exec(
          'INSERT INTO item_meanings (item_id, tenant_id, model, reading, read_at) VALUES (?, ?, ?, ?, ?)',
          itemId,
          ACCOUNT_NAME,
          EMBEDDING_MODEL,
          '[]',
          '2026-09-09T10:00:00.000Z',
        ),
      );
      somethingCanReadMeaning();

      const [batch] = await backfill();

      expect(batch!.read).toEqual([itemId]);
      expect(await itemsWithAMeaning()).toEqual([itemId]);
    });
  });

  describe('the backfill writes what notes mean and which of them repeat each other, and nothing else', () => {
    it('leaves every note exactly as it was', async () => {
      await aNoteNobodyRead(A_NOTE);
      await aNoteNobodyRead(THE_SAME_AGAIN);
      const before = await everyItemRow();
      somethingCanReadMeaning();

      await backfill();

      expect(await everyItemRow()).toEqual(before);
    });

    it('leaves another account’s notes alone, and writes nothing into its store', async () => {
      const mine = await aNoteNobodyRead(A_NOTE);
      await aNoteNobodyRead(THE_SAME_AGAIN);
      const theirs = await aNoteNobodyRead(A_NOTE, { itemId: nextId() }, OTHER_USER_ID);
      somethingCanReadMeaning();

      const [batch] = await backfill();

      expect(batch!.read).toContain(mine);
      expect(batch!.read).not.toContain(theirs);
      expect(await rowsIn('item_meanings', OTHER_ACCOUNT_NAME)).toEqual([]);
      expect(await rowsIn('item_duplicates', OTHER_ACCOUNT_NAME)).toEqual([]);
      expect(await duplicatesIn(WORKSPACE_ID, OTHER_USER_ID)).toEqual([]);
    });
  });

  describe('a pair the backfill finds obeys every rule a captured note’s pairs obey', () => {
    it('is not offered when the two notes are in different workspaces', async () => {
      await alsoWorkspaces();
      await aNoteNobodyRead(A_NOTE);
      await aNoteNobodyRead(THE_SAME_AGAIN, { workspaceId: 'ws-personal', itemId: nextId() });
      somethingCanReadMeaning();

      await backfill();

      expect(await duplicatesIn()).toEqual([]);
      expect(await duplicatesIn('ws-personal')).toEqual([]);
    });

    it('is not offered when one of the two is finished with', async () => {
      const one = await aNoteNobodyRead(A_NOTE);
      const other = await aNoteNobodyRead(THE_SAME_AGAIN);
      somethingCanReadMeaning();
      await backfill();
      expect(await duplicatesIn()).toEqual([pair(one, other)]);

      await postChange('set_done', {
        commandId: nextId(),
        issuedAt: '2026-09-09T11:00:00.000Z',
        workspaceId: WORKSPACE_ID,
        itemId: other,
        done: true,
      });

      expect(await duplicatesIn()).toEqual([]);
    });

    it('stays settled where the pair was already said not to be a duplicate', async () => {
      const one = await aNoteNobodyRead(A_NOTE);
      const other = await aNoteNobodyRead(THE_SAME_AGAIN);
      somethingCanReadMeaning();
      await backfill();
      await postChange('set_duplicate_settled', {
        commandId: nextId(),
        issuedAt: '2026-09-09T11:00:00.000Z',
        workspaceId: WORKSPACE_ID,
        itemId: one,
        otherItemId: other,
        settled: true,
      });
      expect(await duplicatesIn()).toEqual([]);

      // A third note arrives unread and the backfill runs again, rewriting both
      // notes' pairs - the settling is in a table it never touches, so it is
      // untouched and still excludes the pair from being drawn.
      const third = await aNoteNobodyRead('the audit trail question for novy, on part 11');
      await backfill();

      expect(await rowsIn('duplicate_settlements')).toEqual(storedAs([pair(one, other)]));
      const offered = await duplicatesIn();
      expect(offered).toContainEqual(pair(one, third));
      expect(offered).toContainEqual(pair(other, third));
      expect(offered).not.toContainEqual(pair(one, other));
    });

    it('does not pair a note with itself, whichever of the two was read first', async () => {
      const one = await aNoteNobodyRead(A_NOTE);
      const other = await aNoteNobodyRead(THE_SAME_AGAIN);
      await aNoteNobodyRead(SOMETHING_ELSE);
      somethingCanReadMeaning();

      await backfill();

      // One row for the pair, and nothing pairing anything with itself - which
      // is what the store's own CHECK holds and what `pairOf` never has to.
      expect(await rowsIn('item_duplicates')).toEqual(storedAs([pair(one, other)]));
    });
  });

  describe('an environment that cannot read meaning backfills nothing, and says so', () => {
    it('refuses, and writes no reading', async () => {
      await aNoteNobodyRead(A_NOTE);

      const response = await asking(ACCOUNT_NAME);

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: 'this environment cannot read what a note means',
      });
      expect(await rowsIn('item_meanings')).toEqual([]);
    });
  });

  describe('the backfill is the operator’s and names the account it is for', () => {
    it('refuses without the operator’s secret', async () => {
      const response = await SELF.fetch(
        `http://cockpit.test/v1/operator/duplicates/accounts/${ACCOUNT_NAME}`,
        { method: 'POST' },
      );

      expect(response.status).toBe(401);
    });

    it('says which name was wrong, for an account the register has not got', async () => {
      somethingCanReadMeaning();

      const response = await asking('tenant-nobody');

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'no account tenant-nobody' });
    });

    it('refuses a batch that is not a whole number of items', async () => {
      somethingCanReadMeaning();

      const response = await SELF.fetch(
        `http://cockpit.test/v1/operator/duplicates/accounts/${ACCOUNT_NAME}?batch=lots`,
        { method: 'POST', headers: { authorization: `Bearer ${SECRET}` } },
      );

      expect(response.status).toBe(400);
    });

    it('lists the accounts to walk, which is where the command gets them from', async () => {
      const response = await SELF.fetch('http://cockpit.test/v1/operator/duplicates/accounts', {
        headers: { authorization: `Bearer ${SECRET}` },
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ accounts: [OTHER_ACCOUNT_NAME, ACCOUNT_NAME] });
    });
  });
});
