import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import type { CommandName, CommandPayload } from '@cockpit/shared';
import {
  ACCOUNT_NAME,
  WORKSPACE_ID,
  alsoWorkspaces,
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
 * Integration level: a real store, a real queue, and the correction arrives
 * through the real Worker (`SELF.fetch`, via `asUser`). What is faked is the
 * model, at the network boundary - and what is proved is that it is never
 * reached ("Cut what cleaning up a captured note costs", issue 887). A
 * correction used to re-read the texts of every Item still unsettled in the
 * Inbox; it now shapes later captures only.
 *
 * **A key is set before the correction**, which is what makes each case a
 * proof: without one nothing is queued for anybody. Setup runs without one, so
 * no capture-time clean-up races the assertions.
 *
 * **The queue is held, and then drained by hand**: every message the Worker
 * sends is kept, and each is delivered through the real consumer
 * (`handleQueue`) once the correction has returned. Waiting a while and then
 * finding nothing proves nothing - a job takes longer than any wait that is
 * short enough to be worth it - whereas a drained queue has run whatever the
 * correction put on it.
 */
const A_KEY = 'a-key-that-proves-nothing-here';

let asked: string[] = [];

function stubTheModel(): void {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== 'api.anthropic.com') throw new Error(`the suite tried to reach ${url.origin}`);
    const sent = JSON.parse(
      input instanceof Request ? await input.clone().text() : String(init?.body ?? '{}'),
    ) as { messages: { content: string }[] };
    asked.push(sent.messages[0]!.content);
    return Response.json({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5-5',
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            language: 'English',
            title: 'A model-written title',
            message: 'A model-written message',
            readings: [],
            panel: { panelId: '', reason: '' },
          }),
        },
      ],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  });
}

async function postChange<N extends CommandName>(name: N, payload: CommandPayload<N>) {
  return asUser(`http://cockpit.test/v1/commands/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

let seq = 0;
function nextId(): string {
  seq += 1;
  return `018f0000-0000-7000-9100-${String(seq).padStart(12, '0')}`;
}

let issuedAtSeq = 0;
function nextIssuedAt(): string {
  issuedAtSeq += 1;
  return new Date(Date.parse('2026-09-11T10:00:00.000Z') + issuedAtSeq * 1000).toISOString();
}

async function captureANote(note: string): Promise<string> {
  const itemId = nextId();
  const response = await postChange('capture_item', {
    commandId: nextId(),
    issuedAt: nextIssuedAt(),
    workspaceId: WORKSPACE_ID,
    itemId,
    message: note,
    typeId: taskTypeIn(ACCOUNT_NAME),
  });
  expect(response.status).toBe(200);
  return itemId;
}

/**
 * Writes an Item directly with a proposal already standing on it - what a
 * clean-up would have written, without spending a model call to get there.
 * Only an Item in this state has a correction to record.
 */
async function anItemAlreadyProposedFor(note: string, proposedTitle: string): Promise<string> {
  const itemId = nextId();
  const when = nextIssuedAt();
  await inStoreAsItIs(ACCOUNT_NAME, (sql) =>
    sql.exec(
      `INSERT INTO items
         (id, tenant_id, workspace_id, source, captured_message, title, texts_proposed_at, status, unseen, created_at, updated_at)
       VALUES (?, ?, ?, 'internal', ?, ?, ?, 'to_process', 0, ?, ?)`,
      itemId,
      ACCOUNT_NAME,
      WORKSPACE_ID,
      note,
      proposedTitle,
      when,
      when,
      when,
    ),
  );
  return itemId;
}

async function titleOf(itemId: string): Promise<string> {
  const rows = await inStoreAsItIs(ACCOUNT_NAME, (sql) =>
    sql.exec<{ title: string }>('SELECT title FROM items WHERE id = ? AND tenant_id = ?', itemId, ACCOUNT_NAME).toArray(),
  );
  return rows[0]!.title;
}

/** Every row of What Cockpit changed the account holds. */
async function rowsOfWhatCockpitChanged(): Promise<number> {
  const rows = await inStoreAsItIs(ACCOUNT_NAME, (sql) =>
    sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM rewrite_history').toArray(),
  );
  return rows[0]!.n;
}

let held: EnrichmentJob[] = [];
let realQueue: typeof env.ENRICHMENT;

function holdTheQueue(): void {
  realQueue = env.ENRICHMENT;
  env.ENRICHMENT = {
    send: async (body: EnrichmentJob) => {
      held.push(body);
    },
    sendBatch: async () => {
      throw new Error('nothing here sends a batch');
    },
  } as unknown as typeof env.ENRICHMENT;
}

/** Delivers everything the Worker queued through the real consumer, as the queue would; a retry fails the case. */
async function drainTheQueue(): Promise<void> {
  const messages = held;
  held = [];
  for (const body of messages) {
    await handleQueue(
      {
        queue: 'cockpit-enrichment',
        messages: [
          {
            id: crypto.randomUUID(),
            timestamp: new Date(),
            body,
            attempts: 1,
            ack: () => {},
            retry: () => {
              throw new Error(`a ${body.kind} was retried`);
            },
          },
        ],
        ackAll: () => {},
        retryAll: () => {},
      } as unknown as Parameters<typeof handleQueue>[0],
      env,
    );
  }
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  await alsoWorkspaces();
  asked = [];
  held = [];
  env.ANTHROPIC_API_KEY = '';
  await signInAs();
  stubTheModel();
  holdTheQueue();
});

afterEach(() => {
  env.ENRICHMENT = realQueue;
  env.ANTHROPIC_API_KEY = '';
  vi.unstubAllGlobals();
});

describe('Triage', () => {
  describe('correcting a text re-reads nothing in the Inbox', () => {
    it.each([
      {
        situation: 'a corrected title',
        correct: (itemId: string) =>
          postChange('set_title', {
            commandId: nextId(),
            issuedAt: nextIssuedAt(),
            workspaceId: WORKSPACE_ID,
            itemId,
            title: 'Call Jan about the invoice',
          }),
      },
      {
        situation: 'a corrected description',
        correct: (itemId: string) =>
          postChange('set_description', {
            commandId: nextId(),
            issuedAt: nextIssuedAt(),
            workspaceId: WORKSPACE_ID,
            itemId,
            description: 'Ring Jan about the outstanding invoice',
          }),
      },
    ])('$situation leaves every other item as it is, asks the model nothing and adds nothing to What Cockpit changed', async ({ correct }) => {
      const waiting = await captureANote('a note about validation');
      const correcting = await anItemAlreadyProposedFor('call jan about the invoice', 'Call jan');
      // The capture records, without a key, why nothing was enriched; that
      // lands after the response, so it is waited for before counting.
      await vi.waitFor(async () => expect(await rowsOfWhatCockpitChanged()).toBeGreaterThan(0), {
        timeout: 15_000,
        interval: 20,
      });
      const rowsBefore = await rowsOfWhatCockpitChanged();
      env.ANTHROPIC_API_KEY = A_KEY;

      expect((await correct(correcting)).status).toBe(200);

      await drainTheQueue();
      expect(asked).toEqual([]);
      expect(await titleOf(waiting)).toBe('a note about validation');
      expect(await rowsOfWhatCockpitChanged()).toBe(rowsBefore);
    });

    it('a re-read already queued before the change asks the model nothing, and is dropped rather than retried', async () => {
      await captureANote('a note about validation');
      env.ANTHROPIC_API_KEY = A_KEY;
      const acked: string[] = [];
      const queued = {
        id: 'message-1',
        timestamp: new Date(),
        body: { kind: 're-propose-texts', accountName: ACCOUNT_NAME },
        attempts: 1,
        ack: () => acked.push('message-1'),
        retry: () => {
          throw new Error('a message of a kind no longer run was retried');
        },
      };

      await handleQueue(
        { queue: 'cockpit-enrichment', messages: [queued], ackAll: () => {}, retryAll: () => {} } as unknown as Parameters<
          typeof handleQueue
        >[0],
        env,
      );

      expect(acked).toEqual(['message-1']);
      expect(asked).toEqual([]);
    });
  });
});
