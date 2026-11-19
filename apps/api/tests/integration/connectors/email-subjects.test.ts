import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import { applyD1Migrations, env, runDurableObjectAlarm } from 'cloudflare:test';
import type { Connector, ConnectorHost, SourceItem } from '@cockpit/connector-sdk';
import type { EnrichmentJob } from '../../../src/jobs/enrichment.js';
import { handleQueue } from '../../../src/jobs/index.js';
import { seal, sealingKey } from '../../../src/connectors/credential-crypto.js';
import { ACCOUNT_NAME, WORKSPACE_ID, inTheStore, storeNamed } from '../seed.js';
import {
  A_READING,
  aModelThatReads,
  asked,
  batchOf,
  isACleanUp,
  nextId,
  postChange,
  theModelIs,
} from '../http/note-cleanup.support.js';

/**
 * Integration level, through the account's real store, its real alarm and the
 * Worker's real queue consumer, with the model faked at the network: what an
 * email Item arrives as, and what the clean-up is handed to read ("Clean-up
 * reads an email's subject, and a phone signature is removed first", issue
 * 1836). Which lines count as a phone signature is each mail connector's, in
 * its unit tests; here, that an email with nothing left is filed with its texts
 * settled and the clean-up still reads the fields its subject states, and that
 * an email with words left is read with its subject, and no other note is.
 *
 * **A fake pulled connector** emits what the real mail connectors emit, for the
 * filing; it cannot be named `gmail` or `outlook`, which the registry already
 * holds. The clean-up's subject line is keyed on the Item's source, so those
 * cases capture an Item whose source is Gmail or Outlook through the capture
 * route, the way a front door other than a check does.
 */

aModelThatReads();

const MAIL = ['gmail', 'outlook'] as const;
type Mail = (typeof MAIL)[number];
const FAKE_MAIL = 'fake-mail';
const FAKE_TEXTS = 'fake-texts';

const fake = { next: null as ((host: ConnectorHost) => Promise<void>) | null };

const connectorFor = (id: string): Connector => ({
  manifest: { id, displayName: id, cardText: 'A mailbox.', supportsPush: false, pulled: true, mirrorsOpenState: true, auth: { kind: 'none' } },
  async sync(host: ConnectorHost) {
    const script = fake.next;
    fake.next = null;
    await script?.(host);
  },
  async mirrorOpenState() {
    return [];
  },
});

let held: EnrichmentJob[] = [];
let realQueue: typeof env.ENRICHMENT;

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  held = [];
  realQueue = env.ENRICHMENT;
  env.ENRICHMENT = {
    send: async (body: EnrichmentJob) => {
      held.push(body);
    },
    sendBatch: async () => {
      throw new Error('nothing here sends a batch');
    },
  } as unknown as typeof env.ENRICHMENT;
  fake.next = null;
  env.TEST_CONNECTORS = [connectorFor(FAKE_MAIL), connectorFor(FAKE_TEXTS)];
});

afterEach(() => {
  env.ENRICHMENT = realQueue;
  delete env.TEST_CONNECTORS;
});

async function theQueued(kind: EnrichmentJob['kind']): Promise<EnrichmentJob> {
  for (let waited = 0; waited < 10_000; waited += 25) {
    const at = held.findIndex((job) => job.kind === kind);
    if (at >= 0) return held.splice(at, 1)[0]!;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`no ${kind} was ever queued`);
}

async function connect(connectorId: string): Promise<void> {
  const key = await sealingKey(env.CONNECTOR_CREDENTIAL_KEY);
  const sealed = await seal('a-credential', key!);
  const answer = await storeNamed(ACCOUNT_NAME).applyChange(ACCOUNT_NAME, 'connect_source_account', {
    commandId: crypto.randomUUID(),
    issuedAt: new Date().toISOString(), // clock-ok: the store stamps the Items on the real clock, so a person's change must be no older
    workspaceId: WORKSPACE_ID,
    sourceAccountId: crypto.randomUUID(),
    connectorId,
    externalAccountKey: `somebody-on-${connectorId}`,
    displayName: 'somebody',
    ...sealed,
  });
  expect(answer.status).toBe('ok');
  await handleQueue(batchOf(await theQueued('check-a-pulled-connection')), env);
}

/** The alarm firing, and the check it queues delivered, doing what `script` says. */
async function check(script: (host: ConnectorHost) => Promise<void>): Promise<void> {
  fake.next = script;
  await inTheStore((sql) => sql.exec(`UPDATE pulled_connections SET due_at = '2000-01-01T00:00:00.000Z'`));
  await runDurableObjectAlarm(storeNamed(ACCOUNT_NAME));
  await handleQueue(batchOf(await theQueued('check-a-pulled-connection')), env);
}

/** What the real mail connectors emit for an email: the subject as the title, and the text, or the subject standing in for none. */
const email = (title: string, text: string | null): SourceItem => ({
  sourceId: 'm-1',
  sourceLink: null,
  sender: null,
  sourceTimestamp: null,
  title,
  capturedMessage: text ?? title,
  ...(text === null ? { titleIsAll: true as const } : {}),
});

async function theItem() {
  const [row] = await inTheStore((sql) =>
    sql
      .exec<{ id: string; title: string; description: string | null; captured_message: string | null; texts_settled_at: string | null }>(
        `SELECT i.id, i.title, i.description, i.captured_message, i.texts_settled_at
           FROM pulled_links l JOIN items i ON i.id = l.item_id WHERE l.source_id = 'm-1'`,
      )
      .toArray(),
  );
  return row!;
}

async function theItemById(itemId: string) {
  const [row] = await inTheStore((sql) =>
    sql
      .exec<{ id: string; title: string; description: string | null; captured_message: string | null; texts_settled_at: string | null }>(
        'SELECT id, title, description, captured_message, texts_settled_at FROM items WHERE id = ?',
        itemId,
      )
      .toArray(),
  );
  return row!;
}

const cleanUp = async (itemId: string) =>
  handleQueue(batchOf({ kind: 'clean-up-a-note', accountName: ACCOUNT_NAME, itemId, attemptId: nextId() }), env);

describe('Capture', () => {
  describe('an email with nothing left after its signature keeps its subject as typed, with no description, and is never rewritten', () => {
    it.each([
      { situation: 'a subject', subject: 'conselit email', title: 'conselit email' },
      { situation: 'no subject either', subject: '(no subject)', title: '(no subject)' },
    ])('files $situation as the title and nothing as the description, its texts settled, and the clean-up proposes no texts', async ({ subject, title }) => {
      await connect(FAKE_MAIL);
      await check((host) => host.emitItem(email(subject, null)).then(() => {}));

      const filed = await theItem();
      expect(filed).toMatchObject({ title, description: null, captured_message: title });
      expect(filed.texts_settled_at).not.toBeNull();

      theModelIs({ says: { ...A_READING, title: 'Rewritten', message: 'Something else.' } });
      asked.length = 0;
      await cleanUp(filed.id);

      expect(await theItem()).toMatchObject({ title, description: null });
      // Whatever it is asked, it is asked the subject alone, never the subject twice.
      expect(asked.filter(isACleanUp).map((call) => call.note)).toEqual([title]);
    });

    it('still reads the priority and the due date its subject states, and keeps the title', async () => {
      await connect(FAKE_MAIL);
      await check((host) => host.emitItem(email('conselit email urgent tomorrow', null)).then(() => {}));
      const filed = await theItem();
      await inTheStore((sql) => sql.exec(`UPDATE items SET captured_time_zone = 'Europe/Brussels' WHERE id = ?`, filed.id));
      const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10); // clock-ok: the Item was just filed, on the real clock
      theModelIs({ says: { ...A_READING, title: 'Rewritten', message: 'Something else.', priority: 'high', dueDate: tomorrow } });
      asked.length = 0;

      await cleanUp(filed.id);

      expect(await theItem()).toMatchObject({ title: 'conselit email urgent tomorrow', description: null });
      const [read] = await inTheStore((sql) =>
        sql.exec<{ priority: string | null; due_date: string | null }>('SELECT priority, due_date FROM items WHERE id = ?', filed.id).toArray(),
      );
      expect(read).toEqual({ priority: 'high', due_date: tomorrow });
      expect(asked.filter(isACleanUp)).toHaveLength(1);
    });

    it('is still titled with the subject where the clean-up fails', async () => {
      await connect(FAKE_MAIL);
      await check((host) => host.emitItem(email('conselit email', null)).then(() => {}));
      const filed = await theItem();
      theModelIs('fails');

      await cleanUp(filed.id).catch(() => {});

      expect(await theItem()).toMatchObject({ title: 'conselit email', description: null });
    });
  });

  describe('an email with words left is cleaned up with its subject in front of its text', () => {
    it.each(MAIL)('hands the model a %s email\u2019s subject as a line of its own above the text, and stores neither in the other', async (mail: Mail) => {
      const itemId = nextId();
      const saved = await postChange('capture_item', {
        commandId: nextId(),
        issuedAt: '2026-09-09T10:00:00.000Z',
        workspaceId: WORKSPACE_ID,
        itemId,
        message: 'Can you answer before Friday?',
        title: 'Reply to Bryton about subscriptions',
      });
      expect(saved.status).toBe(200);
      // The capture route drops a source a client names, so the Item is made one of the mailbox's, as a check files it.
      await inTheStore((sql) => sql.exec('UPDATE items SET source_connector = ? WHERE id = ?', mail, itemId));
      asked.length = 0;

      await cleanUp(itemId);

      expect(asked.filter(isACleanUp).map((call) => call.note)).toEqual([
        'Reply to Bryton about subscriptions\n\nCan you answer before Friday?',
      ]);
      expect(await theItemById(itemId)).toMatchObject({
        title: A_READING.title,
        description: A_READING.message,
        captured_message: 'Can you answer before Friday?',
      });
    });
  });
});

describe('Capture', () => {
  describe('a note that is not an email is cleaned up without a subject line', () => {
    it.each([
      { situation: 'a note captured in the form' },
      { situation: 'a message saved from a source that is not a mailbox' },
    ])('reads $situation as it was captured', async ({ situation }) => {
      let itemId: string;
      if (situation.startsWith('a note')) {
        itemId = nextId();
        const saved = await postChange('capture_item', {
          commandId: nextId(),
          issuedAt: '2026-09-09T10:00:00.000Z',
          workspaceId: WORKSPACE_ID,
          itemId,
          message: 'Call the plumber',
        });
        expect(saved.status).toBe(200);
      } else {
        await connect(FAKE_TEXTS);
        await check((host) => host.emitItem(email('Text from Jan', 'Call the plumber')).then(() => {}));
        itemId = (await theItem()).id;
      }
      asked.length = 0;

      await cleanUp(itemId);

      expect(asked.filter(isACleanUp).map((call) => call.note)).toEqual(['Call the plumber']);
    });
  });
});
