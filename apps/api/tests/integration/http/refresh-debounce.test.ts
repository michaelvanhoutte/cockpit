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

/**
 * Integration level: a real store holds the record of asks, and the filings
 * that ask arrive through the real Worker (`SELF.fetch`, via `asUser`). What is faked is the model, at the network boundary, and the
 * queue's *timing*: every message the Worker sends is held here, with the
 * delay it was sent with, and delivered through the real consumer
 * (`handleQueue`) when a case says the window has passed - so a burst
 * "within the window" is a burst whose messages are all still held, and no
 * case waits one out ("Debounce the settle-triggered repropose fan-out across
 * a real time window", issue 582).
 *
 * The window is set to the default's own 30 seconds for this file, rather
 * than the suite's `0`, so the delay each message carries is the one a
 * deployment would send.
 */

const WS2 = 'ws-atlas';
const WAITING_NOTE = 'a note only a refresh ever asks about';
const WAITING_ELSEWHERE = 'a note in the other workspace only its refresh asks about';

const PROPOSES_NOTHING = {
  language: 'English',
  title: 'A title',
  message: 'A message',
  readings: [] as unknown[],
  panel: { panelId: '', reason: '' },
};

/** Every call the model was asked, the note and the history it was read against. */
let asked: { note: string; system: string }[] = [];
/** Run inside the model call, before it answers - what lets a case act while a refresh is under way. */
let whileAsked: (note: string) => Promise<void> = async () => {};

function stubTheModel(): void {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== 'api.anthropic.com') throw new Error(`the suite tried to reach ${url.origin}`);
    const sent = JSON.parse(
      input instanceof Request ? await input.clone().text() : String(init?.body ?? '{}'),
    ) as {
      system: string | { text: string }[];
      messages: { content: string }[];
      output_config: { format: { schema: { properties: Record<string, unknown> } } };
    };
    const content = sent.messages[0]!.content;
    // A refresh asks the panel-only question, told apart by the answer it asks for, and sends the note quoted
    // beside the item's title and description ("Use a cheaper model for panel-only re-proposal", issue 583).
    const panelOnly = 'panelId' in sent.output_config.format.schema.properties;
    const note = panelOnly ? (JSON.parse(/^Captured note: (.*)$/m.exec(content)![1]!) as string) : content;
    // A capture's call goes as blocks, the fixed half first and cached ("Enable prompt caching on the note-cleanup
    // prompt", issue 584); a refresh's as one string. Read here as the one text the model sees.
    const system = typeof sent.system === 'string' ? sent.system : sent.system.map((block) => block.text).join('\n\n');
    asked.push({ note, system });
    await whileAsked(note);
    return Response.json({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5',
      content: [{ type: 'text', text: JSON.stringify(panelOnly ? PROPOSES_NOTHING.panel : PROPOSES_NOTHING) }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  });
}

const timesAskedAbout = (note: string) => asked.filter((call) => call.note === note).length;

/** Everything the Worker has put on the queue, in the order it did, and not yet delivered. */
let held: { body: EnrichmentJob; delaySeconds: number | undefined }[] = [];
let realQueue: typeof env.ENRICHMENT;

function holdTheQueue(): void {
  realQueue = env.ENRICHMENT;
  env.ENRICHMENT = {
    send: async (body: EnrichmentJob, options?: { delaySeconds?: number }) => {
      held.push({ body, delaySeconds: options?.delaySeconds });
    },
    sendBatch: async () => {
      throw new Error('nothing here sends a batch');
    },
  } as unknown as typeof env.ENRICHMENT;
}

/** Takes every held refresh of this kind off the queue, oldest first, leaving everything else held. */
function refreshesHeld(kind: 're-propose-panels') {
  const taken = held.filter((message) => message.body.kind === kind);
  held = held.filter((message) => message.body.kind !== kind);
  return taken;
}

/** Delivers messages through the real consumer, each in a batch of its own, as a window elapsing one after another would. */
async function deliverInTurn(messages: readonly { body: EnrichmentJob }[]): Promise<void> {
  for (const message of messages) {
    await handleQueue(
      {
        queue: 'cockpit-enrichment',
        messages: [
          {
            id: crypto.randomUUID(),
            timestamp: new Date(),
            body: message.body,
            attempts: 1,
            ack: () => {},
            retry: () => {
              throw new Error(`a ${message.body.kind} was retried`);
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
  return response;
}

let seq = 0;
function nextId(): string {
  seq += 1;
  return `018f0000-0000-7000-9582-${String(seq).padStart(12, '0')}`;
}

let issuedAtSeq = 0;
function nextIssuedAt(): string {
  issuedAtSeq += 1;
  return new Date(Date.parse('2026-09-28T10:00:00.000Z') + issuedAtSeq * 1000).toISOString();
}

/**
 * An unfiled Item nothing but a refresh ever asks the model about: written
 * directly, since a capture's own clean-up would be a second caller - held
 * here and never delivered, but held all the same.
 */
async function waitingInTheInbox(note: string, { workspaceId = WORKSPACE_ID, proposedTitle = 'Typed by hand' } = {}) {
  const itemId = nextId();
  const when = nextIssuedAt();
  await inStoreAsItIs(ACCOUNT_NAME, (sql) =>
    sql.exec(
      `INSERT INTO items
         (id, tenant_id, workspace_id, source, captured_message, title, texts_proposed_at, status, unseen, created_at, updated_at)
       VALUES (?, ?, ?, 'internal', ?, ?, ?, 'to_process', 0, ?, ?)`,
      itemId,
      ACCOUNT_NAME,
      workspaceId,
      note,
      proposedTitle,
      when,
      when,
      when,
    ),
  );
  return itemId;
}

async function aPanel(name: string, workspaceId = WORKSPACE_ID, dashboardId = DASHBOARD_ID): Promise<string> {
  const panelId = nextId();
  await postChange('add_panel', {
    commandId: nextId(),
    issuedAt: nextIssuedAt(),
    workspaceId,
    dashboardId,
    panelId,
    name,
    kind: 'items',
  });
  return panelId;
}

/** What each Panel holds, in order - a move names the whole of it. */
let onPanel = new Map<string, string[]>();

/** Captures a note and files it on a Panel for the first time - one settle, and one ask for a refresh. */
async function fileANote(note: string, panelId: string, workspaceId = WORKSPACE_ID): Promise<void> {
  const itemId = nextId();
  const order = [...(onPanel.get(panelId) ?? []), itemId];
  onPanel.set(panelId, order);
  await postChange('capture_item', {
    commandId: nextId(),
    issuedAt: nextIssuedAt(),
    workspaceId,
    itemId,
    message: note,
    typeId: TASK_TYPE_ID,
  });
  await postChange('move_item_to_panel', {
    commandId: nextId(),
    issuedAt: nextIssuedAt(),
    workspaceId,
    itemId,
    panelId,
    order,
  });
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  await alsoWorkspaces();
  asked = [];
  held = [];
  onPanel = new Map();
  whileAsked = async () => {};
  env.ANTHROPIC_API_KEY = 'a-key-that-proves-nothing-here';
  env.REPROPOSE_DEBOUNCE_SECONDS = '30';
  await signInAs();
  stubTheModel();
  holdTheQueue();
});

afterEach(() => {
  env.ENRICHMENT = realQueue;
  env.ANTHROPIC_API_KEY = '';
  env.REPROPOSE_DEBOUNCE_SECONDS = '0';
  vi.unstubAllGlobals();
});

describe('Triage', () => {
  describe('a burst of filings refreshes the rest of the Inbox once, after the burst, and never not at all', () => {
    it('a single filing still refreshes the rest of the Inbox, once the window has passed', async () => {
      const panel = await aPanel('Somewhere else');
      await waitingInTheInbox(WAITING_NOTE);

      await fileANote('call jan about the invoice', panel);

      const refreshes = refreshesHeld('re-propose-panels');
      expect(refreshes.map((message) => message.delaySeconds)).toEqual([30]);
      await deliverInTurn(refreshes);
      expect(timesAskedAbout(WAITING_NOTE)).toBe(1);
    });

    it('several filings within the window reach the model once, reading the Inbox as it stands after the last', async () => {
      const panel = await aPanel('Somewhere else');
      await waitingInTheInbox(WAITING_NOTE);

      await fileANote('call jan about the invoice', panel);
      const capturedMidBurst = 'a note captured in the middle of the burst';
      await waitingInTheInbox(capturedMidBurst);
      await fileANote('email priya about the contract', panel);
      await fileANote('book the venue for march', panel);

      await deliverInTurn(refreshesHeld('re-propose-panels'));

      expect(timesAskedAbout(WAITING_NOTE)).toBe(1);
      expect(timesAskedAbout(capturedMidBurst)).toBe(1);
      const theRefresh = asked.find((call) => call.note === WAITING_NOTE)!;
      expect(theRefresh.system).toMatch(/book the venue for march/i);
    });

    it('filings further apart than the window each refresh the rest of the Inbox', async () => {
      const panel = await aPanel('Somewhere else');
      await waitingInTheInbox(WAITING_NOTE);

      await fileANote('call jan about the invoice', panel);
      await deliverInTurn(refreshesHeld('re-propose-panels'));
      await fileANote('email priya about the contract', panel);
      await deliverInTurn(refreshesHeld('re-propose-panels'));

      expect(timesAskedAbout(WAITING_NOTE)).toBe(2);
    });

    it('a filing made while a refresh is under way gets a refresh of its own after it', async () => {
      const panel = await aPanel('Somewhere else');
      await waitingInTheInbox(WAITING_NOTE);
      await fileANote('call jan about the invoice', panel);
      let filedMeanwhile = false;
      whileAsked = async (note) => {
        if (note !== WAITING_NOTE || filedMeanwhile) return;
        filedMeanwhile = true;
        await fileANote('email priya about the contract', panel);
      };

      await deliverInTurn(refreshesHeld('re-propose-panels'));
      expect(filedMeanwhile).toBe(true);
      await deliverInTurn(refreshesHeld('re-propose-panels'));

      const calls = asked.filter((call) => call.note === WAITING_NOTE);
      expect(calls).toHaveLength(2);
      expect(calls[0]!.system).not.toMatch(/email priya about the contract/i);
      expect(calls[1]!.system).toMatch(/email priya about the contract/i);
    });
  });

  describe("a burst in one Workspace never holds back another Workspace's refresh", () => {
    it('each still reaches the model once', async () => {
      const panel = await aPanel('Somewhere else');
      const panelElsewhere = await aPanel('Somewhere else again', WS2, `${WS2}-dashboard-1`);
      await waitingInTheInbox(WAITING_NOTE);
      await waitingInTheInbox(WAITING_ELSEWHERE, { workspaceId: WS2 });

      await fileANote('call jan about the invoice', panel);
      await fileANote('a filing in the other workspace', panelElsewhere, WS2);
      await fileANote('email priya about the contract', panel);

      await deliverInTurn(refreshesHeld('re-propose-panels'));
      expect(timesAskedAbout(WAITING_NOTE)).toBe(1);
      expect(timesAskedAbout(WAITING_ELSEWHERE)).toBe(1);
    });
  });
});
