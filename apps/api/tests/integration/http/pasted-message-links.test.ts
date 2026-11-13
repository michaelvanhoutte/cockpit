import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import type { Connector, MessageAtLink, OnDemandHost } from '@cockpit/connector-sdk';
import { SourceError } from '@cockpit/connector-sdk';
import { ACCOUNT_NAME, WORKSPACE_ID, alsoWorkspaces, asUser, inStoreAsItIs, inTheStore, storeNamed } from '../seed.js';
import { handleQueue } from '../../../src/jobs/index.js';
import type { EnrichmentJob } from '../../../src/jobs/enrichment.js';
import { seal, sealingKey } from '../../../src/connectors/credential-crypto.js';
import {
  A_READING,
  aModelThatReads,
  asked,
  captureANote,
  duringThe,
  historyOf,
  isACleanUp,
  nextId,
  postChange,
  reading,
  textsOf,
} from './note-cleanup.support.js';

/**
 * Integration level: an Own note holding a pasted message link is read from
 * the source the link names, and becomes that source's save ("Read pasted
 * Teams links", issue 1755). The capture comes in through the real route, the
 * job is the one the queue hands over (`handleQueue`), and the store is real;
 * what is faked is the source, as a connector registered for this file alone
 * that reads from a script, and the model, at the network
 * (`note-cleanup.support.ts`). How Teams itself reads a link is its own
 * package's (packages/connectors/teams/tests/unit/reading-a-pasted-link.test.ts).
 *
 * Naming: "command", "queue" and "job" are the architecture's words and stay
 * inside the helpers.
 */

aModelThatReads();

const SOURCE = 'chat-app';
const MARK = 'My note:';
const chatLink = (message = '1731490000000') => `https://chat.example.test/l/message/19:chat-with-els/${message}`;
const CHANNEL_LINK = 'https://chat.example.test/l/message/19:general/1731490000009?groupId=team-sales';
const PERSONAL_LINK = 'https://personal.example.test/l/message/19:at-home/1731490000000';
const HER_MESSAGE = 'Can you send me the Q3 numbers by Friday?';

/** What the source answers each connection, by the credential sealed for it: a message, nothing, or busy. */
let answers: Record<string, MessageAtLink | null | 'busy'> = {};
/** Every read asked: which connection, which link, and the words handed over as the note. */
let reads: { connection: string; link: string; note: string }[] = [];

/** A source whose message links a connection reads by grant, as a chat app's would. */
const connector: Connector = {
  manifest: {
    id: SOURCE,
    displayName: 'Chat app',
    cardText: 'Chat.',
    supportsPush: false,
    auth: { kind: 'none' },
    messageLinks: [
      { host: 'chat.example.test', pathStart: '/l/message/' },
      { host: 'personal.example.test', pathStart: '/l/message/' },
    ],
  },
  async sync() {},
  grantToRead: (link) => (link.includes('personal.example.test') ? null : link.includes('groupId=') ? 'channels' : 'chats'),
  async readMessageAtLink(host: OnDemandHost, link: string, note: string) {
    const connection = (await host.getCredentials()).credential!;
    reads.push({ connection, link, note });
    const answer = answers[connection] ?? null;
    if (answer === 'busy') throw new SourceError('the source answered 429', 429);
    if (!answer) return null;
    return { ...answer, capturedMessage: note ? `${answer.capturedMessage}\n\n${MARK}\n${note}` : answer.capturedMessage };
  },
};

/** Her message, as the source reads it. */
const HERS: MessageAtLink = {
  sourceId: '19:chat-with-els:1731490000000',
  sender: 'Els Maes',
  sentAt: '2026-11-12T08:15:00.000Z',
  capturedMessage: HER_MESSAGE,
};

let held: EnrichmentJob[] = [];
let realQueue: typeof env.ENRICHMENT;

/** A connection of the source in a Workspace, granted what it says, its credential naming it. */
async function aConnection(name: string, granted: string[], workspaceId = WORKSPACE_ID): Promise<string> {
  const sourceAccountId = crypto.randomUUID();
  const sealed = await seal(name, (await sealingKey(env.CONNECTOR_CREDENTIAL_KEY))!);
  const answer = await storeNamed(ACCOUNT_NAME).applyChange(ACCOUNT_NAME, 'connect_source_account', {
    commandId: crypto.randomUUID(),
    issuedAt: '2026-11-12T08:00:00.000Z',
    workspaceId,
    sourceAccountId,
    connectorId: SOURCE,
    externalAccountKey: name,
    displayName: name,
    granted,
    ...sealed,
  });
  expect(answer.status).toBe('ok');
  return sourceAccountId;
}

/** The note captured through the real route, and the reading it queued, held back until a case hands it over. */
async function captured(message: string, overrides: Parameters<typeof captureANote>[0] = {}): Promise<{ itemId: string; job: EnrichmentJob }> {
  const itemId = await captureANote({ message, ...overrides });
  let job: EnrichmentJob | undefined;
  await vi.waitFor(
    () => {
      job = held.find((one) => one.kind === 'clean-up-a-note' && one.itemId === itemId);
      expect(job).toBeDefined();
    },
    { timeout: 10_000, interval: 25 },
  );
  return { itemId, job: job! };
}

/** The held reading handed over as the queue would, on its `attempts`-th delivery; whether it asked to be tried again. */
async function delivered(job: EnrichmentJob, attempts = 1): Promise<{ retried: boolean }> {
  let retried = false;
  await handleQueue(
    {
      queue: 'cockpit-enrichment',
      messages: [
        {
          id: crypto.randomUUID(),
          timestamp: new Date('2026-11-13T10:00:00.000Z'),
          body: job,
          attempts,
          ack: () => {},
          retry: () => void (retried = true),
        },
      ],
      ackAll: () => {},
      retryAll: () => {},
    } as unknown as Parameters<typeof handleQueue>[0],
    env,
  );
  return { retried };
}

/** Where an Item says it came from, read out of the store. */
async function sourceOf(itemId: string) {
  const rows = await inStoreAsItIs(ACCOUNT_NAME, (sql) =>
    sql
      .exec<{ source_connector: string | null; sender: string | null; source_link: string | null; source_timestamp: string | null }>(
        'SELECT source_connector, sender, source_link, source_timestamp FROM items WHERE id = ? AND tenant_id = ?',
        itemId,
        ACCOUNT_NAME,
      )
      .toArray(),
  );
  const row = rows[0]!;
  return { source: row.source_connector ?? 'internal', sender: row.sender, link: row.source_link, at: row.source_timestamp };
}

/** The changes recorded on an Item since it was captured, by name. */
async function changesTo(itemId: string): Promise<string[]> {
  return inStoreAsItIs(ACCOUNT_NAME, (sql) =>
    sql
      .exec<{ name: string }>(
        "SELECT name FROM commands WHERE tenant_id = ? AND json_extract(payload, '$.itemId') = ? AND name != 'capture_item' ORDER BY received_at",
        ACCOUNT_NAME,
        itemId,
      )
      .toArray()
      .map((row) => row.name),
  );
}

/** What Settings › Connections shows of the Workspace's connections, and the history of each. */
async function connectionsCard(): Promise<unknown> {
  const listed = await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/connections`);
  expect(listed.status).toBe(200);
  const card = (await listed.json()) as { sourceAccounts: { id: string }[] };
  expect(card.sourceAccounts).not.toHaveLength(0);
  const histories = await Promise.all(
    card.sourceAccounts.map(async (one) => (await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/connections/${one.id}/history`)).json()),
  );
  return { card, histories };
}

const AS_TYPED =(typed: string) => ({ source: 'internal', sender: null, link: null, at: null, captured: typed });

beforeEach(() => {
  answers = {};
  reads = [];
  held = [];
  realQueue = env.ENRICHMENT;
  env.ENRICHMENT = {
    send: async (body: EnrichmentJob) => void held.push(body),
    sendBatch: async () => {
      throw new Error('nothing here sends a batch');
    },
  } as unknown as typeof env.ENRICHMENT;
  env.TEST_CONNECTORS = [connector];
});

afterEach(() => {
  env.ENRICHMENT = realQueue;
  delete env.TEST_CONNECTORS;
});

/** What an Item is now: where it came from, and its captured message. */
async function nowOf(itemId: string) {
  return { ...(await sourceOf(itemId)), captured: (await textsOf(itemId))!.captured_message };
}

describe('Capture', () => {
  describe('an Own note holding a readable pasted message link becomes that source’s save', () => {
    it.each([
      {
        situation: 'a chat link alone',
        typed: chatLink(),
        granted: ['chats'],
        note: '',
        becomes: { source: SOURCE, sender: 'Els Maes', link: chatLink(), at: HERS.sentAt, captured: HER_MESSAGE },
      },
      {
        situation: 'a chat link with your words',
        typed: `${chatLink()} call her back Friday`,
        granted: ['chats'],
        note: 'call her back Friday',
        becomes: { source: SOURCE, sender: 'Els Maes', link: chatLink(), at: HERS.sentAt, captured: `${HER_MESSAGE}\n\n${MARK}\ncall her back Friday` },
      },
      {
        situation: 'a channel link, read by a connection granted channel posts',
        typed: CHANNEL_LINK,
        granted: ['chats', 'channels'],
        note: '',
        becomes: { source: SOURCE, sender: 'Els Maes', link: CHANNEL_LINK, at: HERS.sentAt, captured: HER_MESSAGE },
      },
    ])('$situation', async ({ typed, granted, note, becomes }) => {
      await aConnection('work', granted);
      answers.work = HERS;
      const { itemId, job } = await captured(typed);

      await delivered(job);

      expect(await nowOf(itemId)).toEqual(becomes);
      expect(reads).toEqual([{ connection: 'work', link: becomes.link, note }]);
      // Her message, and your words as its note, are what the reading read.
      expect(asked.at(-1)?.note).toBe(becomes.captured);
    });

    it.each([
      { situation: 'a channel link, every connection granted chats alone', typed: CHANNEL_LINK, granted: ['chats'] },
      { situation: 'a personal link', typed: PERSONAL_LINK, granted: ['chats', 'channels'] },
    ])('$situation: stays as typed, and nothing is asked', async ({ typed, granted }) => {
      await aConnection('work', granted);
      answers.work = HERS;
      const { itemId, job } = await captured(typed);

      await delivered(job);

      expect(await nowOf(itemId)).toEqual(AS_TYPED(typed));
      expect(reads).toEqual([]);
    });
  });

  describe('a pasted link is read with your connections in turn, and the first that reads it wins', () => {
    it('the Workspace you captured in is asked first, and alone where it reads it', async () => {
      await alsoWorkspaces();
      await aConnection('elsewhere', ['chats'], 'ws-atlas');
      await aConnection('here', ['chats']);
      answers = { here: HERS, elsewhere: HERS };
      const { job } = await captured(chatLink());

      await delivered(job);

      expect(reads.map((one) => one.connection)).toEqual(['here']);
    });

    it.each([
      { situation: 'captured on Any workspace', decided: false, hereToo: true },
      { situation: 'captured in a Workspace with no such connection', decided: true, hereToo: false },
    ])('$situation, another Workspace’s connection reads it', async ({ decided, hereToo }) => {
      await alsoWorkspaces();
      await aConnection('elsewhere', ['chats'], 'ws-atlas');
      if (hereToo) await aConnection('here', ['chats']);
      answers = { elsewhere: HERS };
      const { itemId, job } = await captured(chatLink(), { workspaceDecided: decided });

      await delivered(job);

      expect((await sourceOf(itemId)).sender).toBe('Els Maes');
      expect(reads.at(-1)?.connection).toBe('elsewhere');
    });

    it('the first refused (another organisation’s), the second reads it', async () => {
      await alsoWorkspaces();
      await aConnection('other-organisation', ['chats']);
      await aConnection('own-organisation', ['chats'], 'ws-atlas');
      answers = { 'own-organisation': HERS };
      const { itemId, job } = await captured(chatLink());

      await delivered(job);

      expect(reads.map((one) => one.connection)).toEqual(['other-organisation', 'own-organisation']);
      expect((await sourceOf(itemId)).sender).toBe('Els Maes');
    });

    it('no connection granted anything: stays as typed, and nothing is asked', async () => {
      await aConnection('work', []);
      answers.work = HERS;
      const { itemId, job } = await captured(chatLink());

      await delivered(job);

      expect(await nowOf(itemId)).toEqual(AS_TYPED(chatLink()));
      expect(reads).toEqual([]);
    });
  });

  describe('a pasted link that cannot be read leaves the note as typed, and the connection is never marked failing', () => {
    it('the source busy, with tries left: tried again later, and nothing written', async () => {
      await aConnection('work', ['chats']);
      answers.work = 'busy';
      const { itemId, job } = await captured(chatLink());

      expect(await delivered(job)).toEqual({ retried: true });

      expect(await nowOf(itemId)).toEqual(AS_TYPED(chatLink()));
      expect(await changesTo(itemId)).toEqual([]);
      expect(asked).toEqual([]);
    });

    it('the source busy on the last try: read as typed, and titled from your note as today', async () => {
      await aConnection('work', ['chats']);
      answers.work = 'busy';
      const { itemId, job } = await captured(chatLink());

      expect(await delivered(job, 4)).toEqual({ retried: false });

      expect(await nowOf(itemId)).toEqual(AS_TYPED(chatLink()));
      expect(asked.at(-1)?.note).toBe(chatLink());
      expect((await textsOf(itemId))?.title).toBe(A_READING.title);
    });

    it.each([{ situation: 'the message deleted' }, { situation: 'access refused' }])(
      '$situation: as typed, and the connection’s card unchanged',
      async () => {
        await aConnection('work', ['chats']);
        answers.work = null;
        const { itemId, job } = await captured(chatLink());
        const card = await connectionsCard();

        await delivered(job);

        expect(await nowOf(itemId)).toEqual(AS_TYPED(chatLink()));
        expect(await connectionsCard()).toEqual(card);
      },
    );

    it('Claude not set: the message is read alone, and titled from her message as any capture is', async () => {
      env.ANTHROPIC_API_KEY = '';
      await aConnection('work', ['chats']);
      answers.work = HERS;
      const { itemId, job } = await captured(chatLink());

      await delivered(job);

      expect((await nowOf(itemId)).captured).toBe(HER_MESSAGE);
      expect((await textsOf(itemId))?.title).toBe(HER_MESSAGE);
      expect(asked).toEqual([]);
    });

    it('Claude not set and a link nothing can read: settled at capture, with no reading queued', async () => {
      env.ANTHROPIC_API_KEY = '';
      await aConnection('work', ['chats']);
      const itemId = await captureANote({ message: PERSONAL_LINK });

      await vi.waitFor(async () => expect((await historyOf(itemId))[0]).toMatchObject({ status: 'left-as-is' }), { timeout: 10_000, interval: 25 });

      expect(held.filter((one) => one.kind === 'clean-up-a-note')).toEqual([]);
      expect(reads).toEqual([]);
    });
  });

  describe('a pasted link’s message and the reading of it land in one change, once', () => {
    it('a read and a reading: one change recorded', async () => {
      await aConnection('work', ['chats']);
      answers.work = HERS;
      const { itemId, job } = await captured(chatLink());

      await delivered(job);

      expect(await changesTo(itemId)).toEqual(['read_pasted_link']);
      expect((await textsOf(itemId))?.title).toBe(A_READING.title);
    });

    it('delivered twice: the second changes nothing of it', async () => {
      await aConnection('work', ['chats']);
      answers.work = HERS;
      const { itemId, job } = await captured(chatLink());
      await delivered(job);
      const first = await nowOf(itemId);
      answers.work = { ...HERS, sender: 'Somebody else', capturedMessage: 'Another message' };

      await delivered(job);

      expect(await nowOf(itemId)).toEqual(first);
      expect(reads).toHaveLength(1);
    });

    it('a title you edited first: her message is read in, and your title and description kept', async () => {
      await aConnection('work', ['chats']);
      answers.work = HERS;
      const { itemId, job } = await captured(chatLink());
      expect(
        (
          await postChange('set_title', {
            commandId: nextId(),
            issuedAt: '2026-09-09T10:00:01.000Z',
            workspaceId: WORKSPACE_ID,
            itemId,
            title: 'Mine',
          })
        ).status,
      ).toBe(200);
      const yours = (await textsOf(itemId))!.description;

      await delivered(job);

      expect(await nowOf(itemId)).toMatchObject({ source: SOURCE, sender: 'Els Maes', captured: HER_MESSAGE });
      expect(await textsOf(itemId)).toMatchObject({ title: 'Mine', description: yours });
    });

    it('a title you edit while the note is being read: her message is read in, your title kept, and the history says the texts were not written', async () => {
      await aConnection('work', ['chats']);
      answers.work = HERS;
      const { itemId, job } = await captured(chatLink());
      reading.during = duringThe(isACleanUp, async () =>
        expect(
          (
            await postChange('set_title', {
              commandId: nextId(),
              issuedAt: '2026-09-09T10:00:01.000Z',
              workspaceId: WORKSPACE_ID,
              itemId,
              title: 'Mine',
            })
          ).status,
        ).toBe(200),
      );

      await delivered(job);

      expect(await nowOf(itemId)).toMatchObject({ source: SOURCE, sender: 'Els Maes', captured: HER_MESSAGE });
      expect((await textsOf(itemId))?.title).toBe('Mine');
      expect((await historyOf(itemId))[0]).toMatchObject({ status: 'left-as-is' });
    });

    it('an Item a source saved itself: the change is refused, and it stays as it is', async () => {
      const itemId = await captureANote({ message: 'Saved from the app' });
      await inTheStore((sql) => void sql.exec('UPDATE items SET source_connector = ?, source_link = ? WHERE id = ?', SOURCE, chatLink(), itemId));
      const before = await nowOf(itemId);

      const answer = await storeNamed(ACCOUNT_NAME).applyChange(ACCOUNT_NAME, 'read_pasted_link', {
        commandId: crypto.randomUUID(),
        issuedAt: '2026-11-13T10:00:00.000Z',
        workspaceId: WORKSPACE_ID,
        itemId,
        capturedFrom: { source: SOURCE, sourceId: 'another', sourceLink: chatLink('2'), sender: 'Somebody' },
        capturedMessage: 'Another message',
      });

      expect(answer).toMatchObject({ status: 'ok', value: { applied: false } });
      expect(await nowOf(itemId)).toEqual(before);
    });
  });

  describe('only an Own note is read from its pasted link', () => {
    it('Claude’s capture holding a link keeps Claude as its source', async () => {
      await aConnection('work', ['chats']);
      answers.work = HERS;
      const { itemId, job } = await captured(chatLink());
      await inTheStore((sql) => void sql.exec("UPDATE items SET source_connector = 'mcp', sender = 'Claude' WHERE id = ?", itemId));

      await delivered(job);

      expect(await sourceOf(itemId)).toMatchObject({ source: 'mcp', sender: 'Claude' });
      expect(reads).toEqual([]);
    });
  });
});
