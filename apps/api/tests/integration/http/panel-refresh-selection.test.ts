import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import type { CommandName, CommandPayload } from '@cockpit/shared';
import {
  ACCOUNT_NAME,
  DASHBOARD_ID,
  TASK_TYPE_ID,
  WORKSPACE_ID,
  alsoWorkspaces,
  asUser,
  inStoreAsItIs,
  seedRegister,
  signInAs,
  startFromEmpty,
} from '../seed.js';
import { handleQueue } from '../../../src/jobs/index.js';
import type { EnrichmentJob } from '../../../src/jobs/enrichment.js';
import { EMBEDDING_MODEL } from '../../../src/embeddings/index.js';

/**
 * Integration level: the meanings and the filings a refresh weighs its
 * candidates by are store reads, and the filings arrive through the real
 * Worker (`SELF.fetch`, via `asUser`). What is faked is the model, at the
 * network boundary, and the queue's *timing*, as `refresh-debounce.test.ts`
 * does. Which candidates the weighing picks, case by case, is the unit tier's
 * (`panel-refresh.test.ts`); this holds that the job gives it the right
 * meanings and the right filings ("Cut what cleaning up a captured note
 * costs", issue 887).
 *
 * **A meaning is written straight into the store**, as a vector of chosen
 * direction: the Workers AI model that would read one is not under test, and
 * a direction is what makes two notes close or far.
 */

const CLOSE_NOTE = 'a note close to what gets filed';
const FAR_NOTE = 'a note nothing like what gets filed';

/** Three directions, each at a right angle to the others: a note is close to another only along the same one. */
const TOWARDS = { filed: [1, 0, 0], other: [0, 1, 0], unrelated: [0, 0, 1] } as const;

const PROPOSES_NOTHING = { panelId: '', reason: '' };

let asked: string[] = [];
/** Whether the model answers every call with a failure, as an outage or a refused request would. */
let failing = false;
/** The system blocks and model of every call, in order. */
let sentBlocks: { model: string; blocks: { text: string; cache_control?: unknown }[] }[] = [];

function stubTheModel(): void {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== 'api.anthropic.com') throw new Error(`the suite tried to reach ${url.origin}`);
    const sent = JSON.parse(
      input instanceof Request ? await input.clone().text() : String(init?.body ?? '{}'),
    ) as { model: string; system: { text: string; cache_control?: unknown }[]; messages: { content: string }[] };
    sentBlocks.push({ model: sent.model, blocks: sent.system });
    asked.push(JSON.parse(/^Captured note: (.*)$/m.exec(sent.messages[0]!.content)![1]!) as string);
    // A 400 rather than a 5xx, so the client's own retry does not ask twice.
    if (failing) return Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'refused' } }, { status: 400 });
    return Response.json({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-4-5',
      content: [{ type: 'text', text: JSON.stringify(PROPOSES_NOTHING) }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  });
}

const timesAskedAbout = (note: string) => asked.filter((one) => one === note).length;

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

/** Delivers the refreshes held through the real consumer, then forgets them. */
async function runTheRefresh(): Promise<void> {
  const refreshes = held.filter((job) => job.kind === 're-propose-panels');
  held = held.filter((job) => job.kind !== 're-propose-panels');
  for (const job of refreshes) {
    await handleQueue(
      {
        queue: 'cockpit-enrichment',
        messages: [
          {
            id: crypto.randomUUID(),
            timestamp: new Date(),
            body: job,
            attempts: 1,
            ack: () => {},
            retry: () => {
              throw new Error('a refresh was retried');
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

async function postChange<N extends CommandName>(name: N, payload: CommandPayload<N>) {
  const response = await asUser(`http://cockpit.test/v1/commands/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  expect(response.status).toBe(200);
}

let seq = 0;
function nextId(): string {
  seq += 1;
  return `018f0000-0000-7000-9887-${String(seq).padStart(12, '0')}`;
}

/** Written as the clock stands: a filing is weighed against the refresh before it by when it was made. */
const now = () => new Date().toISOString();

async function aMeaning(itemId: string, reading: readonly number[]): Promise<void> {
  await inStoreAsItIs(ACCOUNT_NAME, (sql) =>
    sql.exec(
      'INSERT INTO item_meanings (item_id, tenant_id, model, reading, read_at) VALUES (?, ?, ?, ?, ?)',
      itemId,
      ACCOUNT_NAME,
      EMBEDDING_MODEL,
      JSON.stringify(reading),
      now(),
    ),
  );
}

/** An unfiled Item only a refresh ever asks the model about, with the meaning given. */
async function waitingInTheInbox(note: string, reading: readonly number[]): Promise<string> {
  const itemId = nextId();
  const when = now();
  await inStoreAsItIs(ACCOUNT_NAME, (sql) =>
    sql.exec(
      `INSERT INTO items
         (id, tenant_id, workspace_id, source, captured_message, title, texts_proposed_at, status, unseen, created_at, updated_at)
       VALUES (?, ?, ?, 'internal', ?, ?, ?, 'to_process', 0, ?, ?)`,
      itemId,
      ACCOUNT_NAME,
      WORKSPACE_ID,
      note,
      'Typed by hand',
      when,
      when,
      when,
    ),
  );
  await aMeaning(itemId, reading);
  return itemId;
}

let panelId: string;
let onPanel: string[] = [];

/** Captures a note, gives it a meaning, and files it on the Panel for the first time - one settled filing. */
async function fileANote(note: string, reading: readonly number[]): Promise<void> {
  const itemId = nextId();
  onPanel = [...onPanel, itemId];
  await postChange('capture_item', {
    commandId: nextId(),
    issuedAt: now(),
    workspaceId: WORKSPACE_ID,
    itemId,
    message: note,
    typeId: TASK_TYPE_ID,
  });
  await aMeaning(itemId, reading);
  await postChange('move_item_to_panel', {
    commandId: nextId(),
    issuedAt: now(),
    workspaceId: WORKSPACE_ID,
    itemId,
    panelId,
    order: onPanel,
  });
}

async function rowsOfWhatCockpitChangedFor(itemId: string): Promise<number> {
  const rows = await inStoreAsItIs(ACCOUNT_NAME, (sql) =>
    sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM rewrite_history WHERE item_id = ?', itemId).toArray(),
  );
  return rows[0]!.n;
}

/** Long enough that a filing made next is later than the refresh that just ran, by the clock both are written with. */
const aMomentLater = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  await alsoWorkspaces();
  asked = [];
  failing = false;
  sentBlocks = [];
  held = [];
  onPanel = [];
  env.ANTHROPIC_API_KEY = 'a-key-that-proves-nothing-here';
  await signInAs();
  stubTheModel();
  holdTheQueue();
  panelId = nextId();
  await postChange('add_panel', {
    commandId: nextId(),
    issuedAt: now(),
    workspaceId: WORKSPACE_ID,
    dashboardId: DASHBOARD_ID,
    panelId,
    name: 'Somewhere else',
    kind: 'items',
  });
});

afterEach(() => {
  env.ENRICHMENT = realQueue;
  env.ANTHROPIC_API_KEY = '';
  vi.unstubAllGlobals();
});

describe('Triage', () => {
  describe('a filing re-reads the Panel only of the unfiled items close in meaning to what was filed since the last refresh', () => {
    it('asks about the close item and not the far one, and only the close one appears in What Cockpit changed', async () => {
      const close = await waitingInTheInbox(CLOSE_NOTE, TOWARDS.filed);
      const far = await waitingInTheInbox(FAR_NOTE, TOWARDS.unrelated);
      // The first refresh has no earlier one to weigh the filing against, so it asks about both.
      await fileANote('an earlier filing', TOWARDS.other);
      await runTheRefresh();
      expect([timesAskedAbout(CLOSE_NOTE), timesAskedAbout(FAR_NOTE)]).toEqual([1, 1]);
      await aMomentLater();

      await fileANote('call jan about the invoice', TOWARDS.filed);
      await runTheRefresh();

      expect([timesAskedAbout(CLOSE_NOTE), timesAskedAbout(FAR_NOTE)]).toEqual([2, 1]);
      expect([await rowsOfWhatCockpitChangedFor(close), await rowsOfWhatCockpitChangedFor(far)]).toEqual([2, 1]);
    });

    it('asks Haiku 4.5, with what it learns from sent stable-first and cached after the instructions and after the history', async () => {
      await waitingInTheInbox(CLOSE_NOTE, TOWARDS.filed);
      await fileANote('an earlier filing', TOWARDS.other);

      await runTheRefresh();

      expect(sentBlocks).toHaveLength(1);
      const { model, blocks } = sentBlocks[0]!;
      expect(model).toBe('claude-haiku-4-5');
      expect(blocks.map((block) => block.cache_control)).toEqual([{ type: 'ephemeral' }, { type: 'ephemeral' }, undefined]);
      expect(blocks[1]!.text).toContain('Decision history');
      expect(blocks[2]!.text).toContain('Recently captured');
    });

    it('a second refresh is judged against the filings since the first, not again against the first’s', async () => {
      await waitingInTheInbox(CLOSE_NOTE, TOWARDS.filed);
      await waitingInTheInbox(FAR_NOTE, TOWARDS.unrelated);
      await fileANote('an earlier filing', TOWARDS.other);
      await runTheRefresh();
      await aMomentLater();
      await fileANote('call jan about the invoice', TOWARDS.filed);
      await runTheRefresh();
      await aMomentLater();

      await fileANote('plan the offsite', TOWARDS.unrelated);
      await runTheRefresh();

      // Close to the first filing, far from the second: asked once for the first and not again.
      expect([timesAskedAbout(CLOSE_NOTE), timesAskedAbout(FAR_NOTE)]).toEqual([2, 2]);
    });

    it('a refresh whose every call failed leaves its filings to be weighed again by the next', async () => {
      await waitingInTheInbox(CLOSE_NOTE, TOWARDS.filed);
      await waitingInTheInbox(FAR_NOTE, TOWARDS.unrelated);
      await fileANote('an earlier filing', TOWARDS.other);
      await runTheRefresh();
      await aMomentLater();
      failing = true;
      await fileANote('call jan about the invoice', TOWARDS.filed);
      await runTheRefresh();
      expect(timesAskedAbout(CLOSE_NOTE)).toBe(2);
      failing = false;
      await aMomentLater();

      await fileANote('plan the offsite', TOWARDS.unrelated);
      await runTheRefresh();

      // Close to the filing whose refresh failed, so asked about again; far from it but close to the latest.
      expect([timesAskedAbout(CLOSE_NOTE), timesAskedAbout(FAR_NOTE)]).toEqual([3, 2]);
    });
  });
});
