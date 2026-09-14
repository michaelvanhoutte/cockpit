import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import type { CommandName, CommandPayload, PossibleDuplicate, ServerEvent } from '@cockpit/shared';
import {
  ACCOUNT_NAME,
  OTHER_USER_ID,
  TASK_TYPE_ID,
  WORKSPACE_ID,
  alsoWorkspaces,
  asUser,
  inStoreAsItIs,
  seedRegister,
  signInAs,
  startFromEmpty,
  storeNamed,
} from '../seed.js';
import { handleQueue } from '../../../src/jobs/index.js';
import type { EnrichmentJob } from '../../../src/jobs/enrichment.js';

/**
 * Integration level: a real store, a real schema and the real Worker
 * (`SELF.fetch`, via `asUser`), so the route, the queue this Worker declares
 * and its own consumer all run. What is faked is the one horizontal dependency
 * - what reads meaning, at the binding, exactly as the model is faked at the
 * network boundary next door (tests/integration/http/note-cleanup.test.ts).
 *
 * **These rules need a real store and cannot be asked lower down.** Which Items
 * are eligible is four complementary filters in one query, a pair being one row
 * whichever way round it is written is a constraint in the schema, and one
 * Workspace never seeing another's is what every query's `tenant_id` and
 * `workspace_id` are for. Whether two notes that *say* the same thing actually
 * read alike is neither this tier's question nor a fake's to answer
 * (tests/contract/read-what-a-note-means.test.ts).
 */

/**
 * What the reader is: a reading per meaning, and a refusal for anything the
 * case did not say the meaning of.
 *
 * **Refusing rather than falling back**, because a fallback is a reading two
 * unrelated notes would share - which is the exact answer half the cases here
 * are asserting the absence of, arrived at by accident.
 */
const MEANINGS: Record<string, number[]> = {
  novy: [1, 0],
  milk: [0, 1],
};

/** Two notes about Novy and one about the shopping - the second being what "not a duplicate" looks like. */
const A_NOTE = 'part 11 audit trail question for novy';
const THE_SAME_AGAIN = 'novy, and the audit trail on part 11';
const SOMETHING_ELSE = 'buy milk on the way home';

let read: string[] = [];
/** What happens when a note is read - so a case can make the reading fail. */
let readingGoes: 'well' | 'wrong' = 'well';

function readingOf(text: string): number[] {
  const found = Object.entries(MEANINGS).find(([word]) => text.toLowerCase().includes(word));
  if (!found) throw new Error(`this case did not say what "${text}" means`);
  return found[1];
}

/** Puts a reader on the binding, and records every note it is given. */
function somethingCanReadMeaning(): void {
  (env as unknown as { AI: unknown }).AI = {
    run: async (_model: string, input: { text: string[] }) => {
      const text = input.text[0]!;
      read.push(text);
      if (readingGoes === 'wrong') throw new Error('the reader could not be reached');
      return { data: [readingOf(text)] };
    },
  };
}

async function postChange<N extends CommandName>(
  name: N,
  payload: CommandPayload<N>,
  userId?: string,
) {
  return asUser(
    `http://cockpit.test/v1/commands/${name}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    },
    userId,
  );
}

let seq = 0;
function nextId(): string {
  seq += 1;
  return `018f0000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
}

async function captureANote(
  message: string,
  overrides: Partial<CommandPayload<'capture_item'>> = {},
): Promise<string> {
  const itemId = overrides.itemId ?? nextId();
  const response = await postChange('capture_item', {
    commandId: nextId(),
    issuedAt: '2026-09-09T10:00:00.000Z',
    workspaceId: WORKSPACE_ID,
    itemId,
    message,
    typeId: TASK_TYPE_ID,
    ...overrides,
  });
  expect(response.status).toBe(200);
  return itemId;
}

/** What the Workspace's own snapshot says about which of its notes repeat which. */
async function duplicatesIn(workspaceId = WORKSPACE_ID): Promise<PossibleDuplicate[]> {
  const response = await asUser(`http://cockpit.test/v1/workspaces/${workspaceId}/snapshot`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { duplicates: PossibleDuplicate[] }).duplicates;
}

/** Waits for the notes captured so far to have been read, which capture never waits for. */
async function untilEveryNoteHasBeenRead(howMany: number): Promise<void> {
  await vi.waitFor(
    () => {
      expect(read.length).toBeGreaterThanOrEqual(howMany);
    },
    { timeout: 15_000, interval: 50 },
  );
}

/** Waits for the Workspace to be drawing exactly these pairs. */
async function untilTheWorkspaceShows(pairs: PossibleDuplicate[]): Promise<void> {
  await vi.waitFor(
    async () => {
      expect(await duplicatesIn()).toEqual(pairs);
    },
    { timeout: 15_000, interval: 50 },
  );
}

/** Waits for exactly these notes to have been paired, whoever is drawing them. */
async function untilTheseNotesArePaired(pairs: PossibleDuplicate[]): Promise<void> {
  await vi.waitFor(
    async () => {
      expect(await rowsIn('item_duplicates')).toEqual(storedAs(pairs));
    },
    { timeout: 15_000, interval: 50 },
  );
}

/**
 * How current a tab's copy of the Workspace is - what the snapshot it just read
 * is stamped with, and what it would ask for changes since.
 */
async function howCurrentTheWorkspaceIs(): Promise<string> {
  const response = await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/snapshot`);
  expect(response.status).toBe(200);
  const { upTo } = (await response.json()) as { upTo?: string };
  expect(upTo).toBeDefined();
  return upTo!;
}

/**
 * What the account would tell an open tab has changed since then - asked of the
 * store rather than through `/v1/events`, the same way and for the same reason
 * tests/integration/accounts/liveness.test.ts asks it: the endpoint's own job is
 * to hold a connection open and poll.
 */
async function changesSince(since: string): Promise<{ events: ServerEvent[] }> {
  const answer = await storeNamed(ACCOUNT_NAME).changesSince(ACCOUNT_NAME, since);
  expect(answer).toMatchObject({ status: 'ok' });
  return (answer as { status: 'ok'; value: { events: ServerEvent[] } }).value;
}

/** A pair as the store keeps it: the smaller id first, whichever was read last. */
function pair(one: string, other: string): PossibleDuplicate {
  return one < other ? { itemId: one, otherItemId: other } : { itemId: other, otherItemId: one };
}

/** Two notes that say the same thing, read and paired. */
async function twoNotesSayingTheSameThing(): Promise<[string, string]> {
  const one = await captureANote(A_NOTE);
  const other = await captureANote(THE_SAME_AGAIN);
  await untilTheWorkspaceShows([pair(one, other)]);
  return [one, other];
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  read = [];
  readingGoes = 'well';
  await signInAs();
  await signInAs(OTHER_USER_ID);
  somethingCanReadMeaning();
});

afterEach(() => {
  Reflect.deleteProperty(env as unknown as Record<string, unknown>, 'AI');
  env.EMBEDDINGS_STAND_IN = '';
  env.ANTHROPIC_API_KEY = '';
  // One case puts a model on the network (`theModelProposes`); every other case
  // in this file would otherwise inherit it.
  vi.unstubAllGlobals();
});

describe('Triage', () => {
  describe('only an item you could still act on, in the same workspace, is ever offered as a duplicate', () => {
    it('offers one that is still there to act on', async () => {
      await twoNotesSayingTheSameThing();
    });

    it.each([
      {
        situation: 'the other one is finished with',
        finish: (itemId: string) =>
          postChange('set_done', {
            commandId: nextId(),
            issuedAt: '2026-09-09T11:00:00.000Z',
            workspaceId: WORKSPACE_ID,
            itemId,
            done: true,
          }),
      },
      {
        situation: 'the other one is dismissed, which is what deleting one does',
        finish: (itemId: string) =>
          postChange('set_dismissed', {
            commandId: nextId(),
            issuedAt: '2026-09-09T11:00:00.000Z',
            workspaceId: WORKSPACE_ID,
            itemId,
            dismissed: true,
          }),
      },
    ])('is not offered once $situation', async ({ finish }) => {
      const [, other] = await twoNotesSayingTheSameThing();

      expect((await finish(other)).status).toBe(200);

      expect(await duplicatesIn()).toEqual([]);
    });

    it('is not offered when the other one is in another workspace', async () => {
      await alsoWorkspaces();
      await captureANote(A_NOTE);
      await captureANote(THE_SAME_AGAIN, { workspaceId: 'ws-personal', itemId: nextId() });
      await untilEveryNoteHasBeenRead(2);

      expect(await duplicatesIn()).toEqual([]);
      expect(await duplicatesIn('ws-personal')).toEqual([]);
    });

    /**
     * The other half of the rule above: leaving a pair out is a decision about
     * what to *draw*, so it is taken when the pair is looked at and never by
     * dropping the pair. `replaceDuplicatesOf` clears every pair an Item is in
     * before writing the ones its new reading finds, so a note left out of that
     * comparison takes an existing pair with it and nothing brings it back.
     */
    it('keeps the pair when the two notes belong to different workspaces, across an edit to either', async () => {
      await alsoWorkspaces();
      const here = await captureANote(A_NOTE);
      const there = await captureANote(THE_SAME_AGAIN, {
        workspaceId: 'ws-atlas',
        itemId: nextId(),
      });
      await untilTheseNotesArePaired([pair(here, there)]);

      // Neither workspace offers it, because neither draws both notes.
      expect(await duplicatesIn()).toEqual([]);
      expect(await duplicatesIn('ws-atlas')).toEqual([]);

      const renamed = await postChange('set_title', {
        commandId: nextId(),
        issuedAt: '2026-09-09T11:00:00.000Z',
        workspaceId: WORKSPACE_ID,
        itemId: here,
        title: THE_SAME_AGAIN,
      });
      expect(renamed.status).toBe(200);
      // Driven to the end rather than waited out, so this is not passing on the
      // re-reading not having got there yet.
      await handleQueue(
        batchOf({ kind: 'read-what-a-note-means', accountName: ACCOUNT_NAME, itemId: here }),
        env,
      );

      expect(await rowsIn('item_duplicates')).toEqual(storedAs([pair(here, there)]));
    });

    /**
     * An Item nobody has said the Workspace of is drawn in every Workspace's
     * Inbox at once ("Capture something before you know which workspace it
     * belongs to", issue 165), so it is a duplicate candidate in all of them -
     * and the pair is offered in whichever one is being looked at.
     */
    it('offers one that belongs to no workspace, in the workspace it is drawn in', async () => {
      await alsoWorkspaces();
      const undecided = await captureANote(A_NOTE, { workspaceDecided: false });
      const inWork = await captureANote(THE_SAME_AGAIN);
      await untilTheWorkspaceShows([pair(undecided, inWork)]);

      // The other Workspace draws the undecided note and not the one that
      // belongs here, so there is no pair left for it to offer.
      expect(await duplicatesIn('ws-personal')).toEqual([]);
    });
  });

  describe('one workspace never sees another’s items as duplicates', () => {
    it('marks neither, when two workspaces hold the same note', async () => {
      await alsoWorkspaces();
      await captureANote(A_NOTE);
      await captureANote(A_NOTE, { workspaceId: 'ws-atlas', itemId: nextId() });
      await captureANote(A_NOTE, { workspaceId: 'ws-personal', itemId: nextId() });
      await untilEveryNoteHasBeenRead(3);

      for (const workspaceId of [WORKSPACE_ID, 'ws-atlas', 'ws-personal']) {
        expect(await duplicatesIn(workspaceId)).toEqual([]);
      }
    });
  });

  describe('a flagged pair is one pair, whichever of the two you are looking at', () => {
    it('records two notes captured at once once, and adds nothing when a capture is sent twice', async () => {
      const sameCapture = {
        commandId: nextId(),
        issuedAt: '2026-09-09T10:00:00.000Z',
        workspaceId: WORKSPACE_ID,
        itemId: nextId(),
        message: A_NOTE,
        typeId: TASK_TYPE_ID,
      };
      expect((await postChange('capture_item', sameCapture)).status).toBe(200);
      const other = await captureANote(THE_SAME_AGAIN);
      await untilTheWorkspaceShows([pair(sameCapture.itemId, other)]);

      // One row, not one per direction - which is what makes the pair the same
      // thing found from either Item.
      expect(await rowsIn('item_duplicates')).toEqual(storedAs([pair(sameCapture.itemId, other)]));

      // The very same capture sent again - an offline client retrying - is a
      // replay: nothing is written, so nothing is read again and no second pair
      // appears.
      const readSoFar = read.length;
      const replay = await postChange('capture_item', sameCapture);
      expect(replay.status).toBe(200);
      expect((await replay.json()) as { applied: boolean }).toMatchObject({ applied: false });

      expect(read).toHaveLength(readSoFar);
      expect(await duplicatesIn()).toEqual([pair(sameCapture.itemId, other)]);
    });

    it('lists the other one whichever of the two the pair is looked up from', async () => {
      const [one, other] = await twoNotesSayingTheSameThing();
      const found = await duplicatesIn();

      expect(found.map((one_) => one_.itemId)).toContain(pair(one, other).itemId);
      // Either Item names the other, because the pair carries both ids - which
      // is the whole of what "one pair, whichever you are looking at" means.
      expect([found[0]!.itemId, found[0]!.otherItemId].sort()).toEqual([one, other].sort());
    });
  });

  describe('what cockpit compares is the two texts an item shows, and it compares them again when you change them', () => {
    it('reads the texts capture wrote, where nothing has been proposed', async () => {
      await twoNotesSayingTheSameThing();

      expect(read).toEqual([A_NOTE, THE_SAME_AGAIN]);
    });

    it('reads the texts cockpit proposed, once it has proposed any', async () => {
      // Two notes that say different things as they were typed, which Cockpit
      // then reads into the same two texts - so the only way they can end up
      // paired is if what was compared is what it proposed.
      env.ANTHROPIC_API_KEY = 'a-key-that-proves-nothing-here';
      theModelProposes('novy signs off the part 11 audit trail');
      const one = await captureANote(A_NOTE);
      const other = await captureANote(SOMETHING_ELSE);

      await untilTheWorkspaceShows([pair(one, other)]);
      expect(read).toContain('novy signs off the part 11 audit trail\n\nA fuller message about it.');
    });

    it('reads them again when the title is edited, and the marks change with it', async () => {
      const [one, other] = await twoNotesSayingTheSameThing();

      const renamed = await postChange('set_title', {
        commandId: nextId(),
        issuedAt: '2026-09-09T11:00:00.000Z',
        workspaceId: WORKSPACE_ID,
        itemId: other,
        title: SOMETHING_ELSE,
      });
      expect(renamed.status).toBe(200);

      await untilTheWorkspaceShows([]);
      expect(read).toContain(SOMETHING_ELSE);

      // And back again, which says the mark follows the texts rather than being
      // written once and left.
      const renamedBack = await postChange('set_title', {
        commandId: nextId(),
        issuedAt: '2026-09-09T11:00:01.000Z',
        workspaceId: WORKSPACE_ID,
        itemId: other,
        title: THE_SAME_AGAIN,
      });
      expect(renamedBack.status).toBe(200);
      await untilTheWorkspaceShows([pair(one, other)]);
    });

    it('does not move when only the note as it was captured differs', async () => {
      // Two notes typed differently, given the same two texts by hand: what is
      // compared is what the Item shows, so these are one pair even though what
      // was captured is not the same words.
      const one = await captureANote(A_NOTE);
      const other = await captureANote(SOMETHING_ELSE);
      await untilEveryNoteHasBeenRead(2);
      expect(await duplicatesIn()).toEqual([]);

      for (const itemId of [one, other]) {
        const renamed = await postChange('set_title', {
          commandId: nextId(),
          issuedAt: '2026-09-09T11:00:00.000Z',
          workspaceId: WORKSPACE_ID,
          itemId,
          title: 'Ask novy about it',
        });
        expect(renamed.status).toBe(200);
      }

      await untilTheWorkspaceShows([pair(one, other)]);
      // The two notes still say what was typed into them, untouched.
      expect(await capturedMessagesOf([one, other])).toEqual([A_NOTE, SOMETHING_ELSE]);
    });
  });

  describe('an environment that cannot read meaning flags nothing', () => {
    it('queues nothing and leaves the note as it was', async () => {
      Reflect.deleteProperty(env as unknown as Record<string, unknown>, 'AI');

      const itemId = await captureANote(A_NOTE);
      await captureANote(THE_SAME_AGAIN);

      // Driven to the end rather than waited out, so this is not passing on the
      // queue not having got there yet.
      await handleQueue(
        batchOf({ kind: 'read-what-a-note-means', accountName: ACCOUNT_NAME, itemId }),
        env,
      );

      expect(read).toEqual([]);
      expect(await duplicatesIn()).toEqual([]);
      expect(await rowsIn('item_meanings')).toEqual([]);
    });

    it('still flags where there is no key to clean a note up with', async () => {
      // The suite runs with no Claude key at all (vitest.config.ts), which is
      // the state this case is already in - so flagging happening here is
      // flagging happening without one.
      expect(env.ANTHROPIC_API_KEY).toBe('');

      await twoNotesSayingTheSameThing();
    });
  });

  describe('a note you have finished with or dismissed is not read at all', () => {
    it.each([
      {
        situation: 'dismissed, which is what deleting one does',
        dealWith: (itemId: string) =>
          postChange('set_dismissed', {
            commandId: nextId(),
            issuedAt: '2026-09-09T11:00:00.000Z',
            workspaceId: WORKSPACE_ID,
            itemId,
            dismissed: true,
          }),
      },
      {
        situation: 'finished with',
        dealWith: (itemId: string) =>
          postChange('set_done', {
            commandId: nextId(),
            issuedAt: '2026-09-09T11:00:00.000Z',
            workspaceId: WORKSPACE_ID,
            itemId,
            done: true,
          }),
      },
    ])('reads nothing for a note that has since been $situation', async ({ dealWith }) => {
      // Captured where nothing could read it, so the only reading this note is
      // ever offered is the one delivered below - a reading asked for before
      // the change and arriving after it, which is the ordinary case for
      // anything that waits on a queue.
      Reflect.deleteProperty(env as unknown as Record<string, unknown>, 'AI');
      const itemId = await captureANote(A_NOTE);
      somethingCanReadMeaning();

      expect((await dealWith(itemId)).status).toBe(200);
      await handleQueue(
        batchOf({ kind: 'read-what-a-note-means', accountName: ACCOUNT_NAME, itemId }),
        env,
      );

      // Nothing was spent on it, and nothing was written that no workspace
      // could ever draw a mark from.
      expect(read).toEqual([]);
      expect(await rowsIn('item_meanings')).toEqual([]);
      expect(await rowsIn('item_duplicates')).toEqual([]);
    });
  });

  describe('a note nobody can read is not flagged, and does not stop the ones that can', () => {
    it('reads nothing for a note with nothing written on it', async () => {
      const [one, other] = await twoNotesSayingTheSameThing();
      const readSoFar = read.length;

      const emptied = await postChange('set_title', {
        commandId: nextId(),
        issuedAt: '2026-09-09T11:00:00.000Z',
        workspaceId: WORKSPACE_ID,
        itemId: other,
        title: '   ',
      });
      expect(emptied.status).toBe(200);

      // The pair goes, because the Item it was about now says nothing - and
      // nothing was spent asking what "nothing" means. What it meant while it
      // still said something goes with it, rather than standing over words
      // nobody can see any more.
      await untilTheWorkspaceShows([]);
      expect(read).toHaveLength(readSoFar);
      expect(await rowsIn('item_meanings')).toEqual([
        { item_id: one, reading: '[1,0]' },
        // The emptied note keeps its place and says nothing: the meaning is
        // gone, and the row is what the workspace is told the change on.
        { item_id: other, reading: '[]' },
      ]);
    });

    /**
     * Emptying and dismissing a note both happened before the reading this
     * left queued was ever delivered, so the job meets a note that is both at
     * once. Forgetting has to win regardless: a note nobody can read is the
     * one case this suite already tests for, and being dismissed too must not
     * be a reason to skip it and leave the stale mark standing.
     */
    it('forgets the meaning of a note that was emptied and then dismissed before its reading arrived', async () => {
      const [one, other] = await twoNotesSayingTheSameThing();
      const readSoFar = read.length;

      // Neither change is asked to wait for a reading - there is no key to
      // read with, so nothing this suite has not already delivered by hand
      // runs on its own.
      Reflect.deleteProperty(env as unknown as Record<string, unknown>, 'AI');

      const emptied = await postChange('set_title', {
        commandId: nextId(),
        issuedAt: '2026-09-09T11:00:00.000Z',
        workspaceId: WORKSPACE_ID,
        itemId: other,
        title: '   ',
      });
      expect(emptied.status).toBe(200);

      const dismissed = await postChange('set_dismissed', {
        commandId: nextId(),
        issuedAt: '2026-09-09T11:05:00.000Z',
        workspaceId: WORKSPACE_ID,
        itemId: other,
        dismissed: true,
      });
      expect(dismissed.status).toBe(200);

      // Delivered by hand, as the reading queued before either change - the
      // note it meets is empty and dismissed both.
      somethingCanReadMeaning();
      await handleQueue(
        batchOf({ kind: 'read-what-a-note-means', accountName: ACCOUNT_NAME, itemId: other }),
        env,
      );

      expect(read).toHaveLength(readSoFar);
      expect(await rowsIn('item_meanings')).toEqual([
        { item_id: one, reading: '[1,0]' },
        { item_id: other, reading: '[]' },
      ]);
      expect(await rowsIn('item_duplicates')).toEqual([]);
    });

    /**
     * A reading that *fails* is worth trying again, unlike every decision
     * above, so it throws out of the job and the queue is left to redeliver it
     * - which is the opposite of the note being quietly left unread for ever.
     */
    it('is tried again when reading it fails, and the note is untouched', async () => {
      readingGoes = 'wrong';
      const itemId = await captureANote(A_NOTE);
      await untilEveryNoteHasBeenRead(1);

      let redelivered = false;
      await handleQueue(
        batchOf({ kind: 'read-what-a-note-means', accountName: ACCOUNT_NAME, itemId }, () => {
          redelivered = true;
        }),
        env,
      );

      expect(redelivered).toBe(true);
      expect(await rowsIn('item_meanings')).toEqual([]);
      expect(await capturedMessagesOf([itemId])).toEqual([A_NOTE]);

      // And the note is read normally the moment reading works again, so the
      // failure cost nothing but a delay.
      readingGoes = 'well';
      await handleQueue(
        batchOf({ kind: 'read-what-a-note-means', accountName: ACCOUNT_NAME, itemId }),
        env,
      );
      expect(await rowsIn('item_meanings')).toEqual([expect.objectContaining({ item_id: itemId })]);
    });
  });
});

describe('Live updates', () => {
  describe('a tab is told when a note stops saying what another one already said', () => {
    /**
     * Dropping the mark happens in the reading that follows the edit rather
     * than in the edit itself, so the copy a tab holds the moment the edit
     * lands still carries the mark. Being told once about the edit is therefore
     * not enough - and it is all a tab gets if the forgetting leaves nothing
     * behind for the workspace to be spoken for by.
     */
    it('speaks for the workspace when the mark is dropped, not only when the note was edited', async () => {
      const [, other] = await twoNotesSayingTheSameThing();

      const emptied = await postChange('set_title', {
        commandId: nextId(),
        issuedAt: '2026-09-09T11:00:00.000Z',
        workspaceId: WORKSPACE_ID,
        itemId: other,
        title: '   ',
      });
      expect(emptied.status).toBe(200);

      const asTheTabHasIt = await howCurrentTheWorkspaceIs();
      await untilTheWorkspaceShows([]);

      expect((await changesSince(asTheTabHasIt)).events).toContainEqual(
        expect.objectContaining({ type: 'snapshot_invalidated', workspaceId: WORKSPACE_ID }),
      );
    });
  });
});

/**
 * A model that proposes the same two texts for whatever note it is given -
 * faked at the network boundary, the way tests/integration/http/note-cleanup.test.ts
 * fakes it, because the case above is about what happens *after* a proposal
 * lands rather than about the proposal itself.
 */
function theModelProposes(title: string): void {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== 'api.anthropic.com') throw new Error(`the suite tried to reach ${url.origin}`);
    return Response.json({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5',
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            language: 'English',
            title,
            message: 'A fuller message about it.',
            readings: [],
          }),
        },
      ],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  });
}

/**
 * Rows of one of the two tables this work adds, read straight out of the
 * account's store - `reading` among them, because a note that has been emptied
 * keeps its place and says nothing rather than losing it.
 */
async function rowsIn(table: 'item_meanings' | 'item_duplicates'): Promise<unknown[]> {
  return inStoreAsItIs(ACCOUNT_NAME, (sql) =>
    sql
      .exec(
        table === 'item_meanings'
          ? 'SELECT item_id, reading FROM item_meanings ORDER BY item_id'
          : 'SELECT item_id, other_item_id FROM item_duplicates ORDER BY item_id, other_item_id',
      )
      .toArray(),
  );
}

/** The pairs the store holds, in the shape `rowsIn` reads them back in. */
function storedAs(pairs: readonly PossibleDuplicate[]): unknown[] {
  return pairs.map((one) => ({ item_id: one.itemId, other_item_id: one.otherItemId }));
}

/** What each of these Items was captured as, which nothing here may have changed. */
async function capturedMessagesOf(itemIds: readonly string[]): Promise<(string | null)[]> {
  const rows = await inStoreAsItIs(ACCOUNT_NAME, (sql) =>
    sql
      .exec<{ id: string; captured_message: string | null }>(
        'SELECT id, captured_message FROM items WHERE tenant_id = ?',
        ACCOUNT_NAME,
      )
      .toArray(),
  );
  return itemIds.map((id) => rows.find((row) => row.id === id)?.captured_message ?? null);
}

/** One message, shaped the way the runtime hands them over. */
function batchOf(job: EnrichmentJob, onRetry: () => void = () => {}) {
  const message = {
    id: 'message-1',
    timestamp: new Date(),
    body: job as unknown,
    attempts: 1,
    ack: () => {},
    retry: onRetry,
  };
  return {
    queue: 'cockpit-enrichment',
    messages: [message],
    ackAll: () => {},
    retryAll: () => {},
  } as unknown as Parameters<typeof handleQueue>[0];
}
