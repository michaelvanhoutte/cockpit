import { beforeEach, afterEach, describe, expect, inject, it, vi } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import type { CommandName, CommandPayload } from '@cockpit/shared';
import {
  ACCOUNT_NAME,
  OTHER_ACCOUNT_NAME,
  OTHER_USER_ID,
  TASK_TYPE_ID,
  WORKSPACE_ID,
  asUser,
  inStoreAsItIs,
  seedRegister,
  signInAs,
  startFromEmpty,
  taskTypeIn,
} from '../seed.js';
import { handleQueue } from '../../../src/jobs/index.js';
import type { EnrichmentJob } from '../../../src/jobs/enrichment.js';

/**
 * Integration level: a real store, and the capture arrives through the real
 * Worker (`SELF.fetch`, via `asUser`), so the route, the write path, the queue
 * this Worker declares and its own consumer all run. What is faked is the one
 * horizontal dependency - the model, at the network boundary, exactly as the
 * issuer is faked for signing in (tests/integration/issuer.ts). Whether the
 * real model obeys the prompt is the contract tier's question
 * (tests/contract/clean-up-a-note.test.ts).
 *
 * **The queue is real.** The pool runs this Worker's declared consumer, so a
 * capture really does put a message on a queue and the consumer really does
 * pick it up; the cases below wait for that rather than calling the job. The
 * two that cannot be reached that way - a job naming an item of another account,
 * and one naming an item that has gone - hand a message to `handleQueue`, which
 * is the same entry point the runtime calls.
 *
 * Naming: "command" and "queue" are the architecture's words and stay inside
 * these helpers, out of anything the runner prints.
 */

const NOTE = 'part 11 audit trail q for validation protocol, who signs off eod';
const A_READING = {
  language: 'English',
  title: 'Part 11 audit trail question for the validation protocol',
  message:
    'A question about the Part 11 audit trail, for the validation protocol. Needs to be clear by end of day who signs off on it; the note does not say who that is.',
};

/** A second, different reading, so a case can tell "not rewritten" from "rewritten the same way". */
const SOMETHING_ELSE = {
  language: 'English',
  title: 'Something else entirely',
  message: 'A completely different reading of the same note.',
};

/** What the model does when it is asked. */
type Answering = { says: unknown } | { text: string } | 'fails' | 'declines';

let asked: { system: string; note: string }[] = [];

/**
 * What happens between the note being sent and the answer coming back - which
 * is the only way to reach the window an edit can land in: a person typing
 * while the model is reading.
 */
let whileReading: (() => Promise<unknown>) | null = null;

/**
 * Puts a model on the network, and refuses every other address - so a case that
 * starts talking to the real internet says so instead of quietly costing money.
 */
function theModelIs(answering: Answering): void {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.hostname !== 'api.anthropic.com') {
      throw new Error(`the suite tried to reach ${url.origin}`);
    }

    const sent = JSON.parse(
      input instanceof Request ? await input.clone().text() : String(init?.body ?? '{}'),
    ) as { system: string; messages: { content: string }[] };
    asked.push({ system: sent.system, note: sent.messages[0]!.content });

    if (whileReading) await whileReading();

    if (answering === 'fails') throw new Error('the model could not be reached');
    return Response.json({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5',
      content:
        answering === 'declines'
          ? []
          : [{ type: 'text', text: 'text' in answering ? answering.text : JSON.stringify(answering.says) }],
      stop_reason: answering === 'declines' ? 'refusal' : 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  });
}

async function postChange<N extends CommandName>(name: N, payload: CommandPayload<N>, userId?: string) {
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
  overrides: Partial<CommandPayload<'capture_item'>> = {},
  userId?: string,
): Promise<string> {
  const itemId = overrides.itemId ?? nextId();
  const response = await postChange(
    'capture_item',
    {
      commandId: nextId(),
      issuedAt: '2026-09-09T10:00:00.000Z',
      workspaceId: WORKSPACE_ID,
      itemId,
      message: NOTE,
      typeId: TASK_TYPE_ID,
      ...overrides,
    },
    userId,
  );
  expect(response.status).toBe(200);
  return itemId;
}

/**
 * The two texts an item shows, read out of the store of the account that owns
 * it - which for the case about the boundary between accounts is the whole
 * point: reading somebody else's item out of *this* account's store would
 * answer "nothing" whether the job had written or not.
 */
async function textsOf(itemId: string, accountName = ACCOUNT_NAME) {
  const rows = await inStoreAsItIs(accountName, (sql) =>
    sql
      .exec<{ title: string; description: string | null; captured_message: string | null }>(
        'SELECT title, description, captured_message FROM items WHERE id = ? AND tenant_id = ?',
        itemId,
        accountName,
      )
      .toArray(),
  );
  return rows[0];
}

/**
 * Waits for the note to have been read, which happens after the capture has
 * been answered and is what the whole feature is: capture never waits on it.
 */
async function untilTheNoteHasBeenRead(itemId: string): Promise<void> {
  await vi.waitFor(
    async () => {
      expect((await textsOf(itemId))?.title).toBe(A_READING.title);
    },
    { timeout: 15_000, interval: 50 },
  );
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  asked = [];
  whileReading = null;
  // The suite runs with no key at all (vitest.config.ts), which is what keeps
  // every other file's captures from reaching a model. This file is the one
  // that wants a reading, so it sets one - and the fake below is what the key
  // is spent against.
  env.ANTHROPIC_API_KEY = 'a-key-that-proves-nothing-here';
  // Signed in first, because signing in puts an issuer on the network and would
  // otherwise replace the model put there below.
  await signInAs();
  await signInAs(OTHER_USER_ID);
  theModelIs({ says: A_READING });
});

afterEach(() => {
  env.ANTHROPIC_API_KEY = '';
  vi.unstubAllGlobals();
});

describe('Capture', () => {
  describe('a note you capture is read back and given a title and a message of its own', () => {
    it('replaces both texts with what was read, and keeps the note itself untouched', async () => {
      const itemId = await captureANote();

      await untilTheNoteHasBeenRead(itemId);

      const texts = await textsOf(itemId);
      expect(texts?.description).toBe(A_READING.message);
      expect(texts?.captured_message).toBe(NOTE);
    });

    it('is read whole, and read on its own rather than beside anybody else’s notes', async () => {
      const itemId = await captureANote();

      await untilTheNoteHasBeenRead(itemId);

      expect(asked).toHaveLength(1);
      expect(asked[0]!.note).toBe(NOTE);
      // The one thing sent besides the note is the prompt, which is a file in
      // the repository - so nothing of the account's other items can travel
      // with it (issue 296, "it may add nothing the note does not contain").
      expect(asked[0]!.system).toContain('You are part of Cockpit');
    });

    it('reads a note that belongs to no workspace yet, like any other', async () => {
      const itemId = await captureANote({ workspaceDecided: false });

      await untilTheNoteHasBeenRead(itemId);

      expect((await textsOf(itemId))?.description).toBe(A_READING.message);
    });
  });

  describe('capturing never waits on the reading and never fails because of it', () => {
    it.each([
      { situation: 'nothing was ever set up to read a note', key: '', model: null },
      { situation: 'the model could not be reached', key: 'a-key', model: 'fails' as const },
      { situation: 'the model declined the note', key: 'a-key', model: 'declines' as const },
      { situation: 'the answer was not an answer', key: 'a-key', model: { text: 'Here you go!' } },
      {
        situation: 'the proposed title was the whole note handed back',
        key: 'a-key',
        model: { says: { language: 'English', title: 'x'.repeat(201), message: 'A question.' } },
      },
    ])('succeeds and leaves the note named as it was typed when $situation', async ({ key, model }) => {
      env.ANTHROPIC_API_KEY = key;
      if (model) theModelIs(model);

      const itemId = await captureANote();

      // Answered already, and the note is still named as it was typed - which
      // is the whole of "capture never waits on it".
      expect((await textsOf(itemId))?.title).toBe(NOTE);

      // And then the reading is run to the end, so this is not passing on the
      // queue not having got there yet. Driven rather than waited for: waiting
      // out a negative is a sleep, and a sleep is how a case comes to pass for
      // a reason nobody chose.
      await handleQueue(batchOf({ kind: 'clean-up-a-note', accountName: ACCOUNT_NAME, itemId }), env);

      const texts = await textsOf(itemId);
      expect(texts?.title).toBe(NOTE);
      expect(texts?.description).toBeNull();
    });
  });

  /**
   * **Every case here reads the note once first and then has it read again.**
   * That is not a detour: at-least-once delivery guarantees a second reading
   * eventually, so "what happens the second time" is the real question - and it
   * is the only way to drive the job at a moment this test chooses, a capture
   * having already put a message on the queue of its own.
   */
  describe('a note you have renamed yourself is never rewritten', () => {
    /** The same note read again, which is what the queue will do by itself sooner or later. */
    const readAgain = (itemId: string) =>
      handleQueue(batchOf({ kind: 'clean-up-a-note', accountName: ACCOUNT_NAME, itemId }), env);

    it.each([
      { situation: 'the title', name: 'set_title' as const, field: { title: 'Mine' } },
      {
        situation: 'the description',
        name: 'set_description' as const,
        field: { description: 'Mine to write' },
      },
    ])('leaves both texts alone once you have edited $situation', async ({ name, field }) => {
      const itemId = await captureANote();
      await untilTheNoteHasBeenRead(itemId);
      await postChange(name, {
        commandId: nextId(),
        issuedAt: '2026-09-09T10:00:01.000Z',
        workspaceId: WORKSPACE_ID,
        itemId,
        ...field,
      } as CommandPayload<typeof name>);
      asked = [];
      theModelIs({ says: SOMETHING_ELSE });

      await readAgain(itemId);

      const texts = await textsOf(itemId);
      expect(texts?.title).toBe('title' in field ? 'Mine' : A_READING.title);
      expect(texts?.description).toBe(
        'description' in field ? 'Mine to write' : A_READING.message,
      );
      // And it was never even read a second time: the edit is visible to the
      // job before the model is called at all, so nothing is spent on an answer
      // that would only be refused.
      expect(asked).toHaveLength(0);
    });

    /**
     * The window the job cannot see: the edit lands *after* the note has been
     * sent to be read and *before* the answer comes back, so the check the job
     * made was true when it made it. What refuses the write is the store, on the
     * row as it stands at the moment of writing.
     */
    it('leaves both texts alone when you rename it while Cockpit is still reading', async () => {
      const itemId = await captureANote();
      await untilTheNoteHasBeenRead(itemId);
      asked = [];
      theModelIs({ says: SOMETHING_ELSE });
      whileReading = () =>
        postChange('set_title', {
          commandId: nextId(),
          issuedAt: '2026-09-09T10:00:02.000Z',
          workspaceId: WORKSPACE_ID,
          itemId,
          title: 'Typed while it was thinking',
        });

      await readAgain(itemId);

      expect(asked).toHaveLength(1);
      const texts = await textsOf(itemId);
      expect(texts?.title).toBe('Typed while it was thinking');
      expect(texts?.description).toBe(A_READING.message);
    });
  });

  /**
   * The reading is Cockpit's own, so there is no way to ask for it from
   * outside. Held here rather than left to the comment on the command that says
   * so: the registry's own note says adding a command means adding it there and
   * writing its handler, "no other wiring", and somebody following that
   * mechanically would publish this one.
   */
  describe('the reading is Cockpit’s to do, and cannot be asked for from outside', () => {
    it('offers no address a signed-in browser could send a reading to', async () => {
      const response = await postChange('propose_item_texts', {
        commandId: nextId(),
        issuedAt: '2026-09-09T10:00:00.000Z',
        workspaceId: WORKSPACE_ID,
        itemId: await captureANote(),
        title: 'Sent by hand',
        description: 'Written by hand, and marked as Cockpit’s to overwrite.',
      });

      expect(response.status).toBe(404);
    });
  });

  describe('a note is only ever read for the account it was captured in', () => {
    it('does nothing for an item of another account, and never reads it', async () => {
      const theirs = await captureANote(
        { workspaceId: WORKSPACE_ID, typeId: taskTypeIn(OTHER_ACCOUNT_NAME) },
        OTHER_USER_ID,
      );
      // Their own note is read by their own job first, so what follows is the
      // only reading left to account for.
      await vi.waitFor(
        async () => {
          expect((await textsOf(theirs, OTHER_ACCOUNT_NAME))?.title).toBe(A_READING.title);
        },
        { timeout: 15_000, interval: 50 },
      );
      asked = [];
      theModelIs({ says: SOMETHING_ELSE });

      await handleQueue(
        batchOf({ kind: 'clean-up-a-note', accountName: ACCOUNT_NAME, itemId: theirs }),
        env,
      );

      expect(asked).toHaveLength(0);
      // Their note is untouched by a job naming this account: the read inside
      // the store matched no row, so there was nothing to read or write.
      expect((await textsOf(theirs, OTHER_ACCOUNT_NAME))?.title).toBe(A_READING.title);
    });

    it('does nothing for an item that is no longer there', async () => {
      await handleQueue(
        batchOf({ kind: 'clean-up-a-note', accountName: ACCOUNT_NAME, itemId: nextId() }),
        env,
      );

      expect(asked).toHaveLength(0);
    });
  });
});

/** One message, shaped the way the runtime hands them over. */
function batchOf(job: EnrichmentJob) {
  const message = {
    id: 'message-1',
    timestamp: new Date(),
    body: job as unknown,
    attempts: 1,
    ack: () => {},
    retry: () => {},
  };
  return {
    queue: 'cockpit-enrichment',
    messages: [message],
    ackAll: () => {},
    retryAll: () => {},
  } as unknown as Parameters<typeof handleQueue>[0];
}
