import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import type { CommandName, CommandPayload } from '@cockpit/shared';
import {
  ACCOUNT_NAME,
  OTHER_ACCOUNT_NAME,
  OTHER_USER_ID,
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
 * through the real Worker (`SELF.fetch`, via `asUser`) - the same shape
 * `repropose-panels.test.ts` already exercises for the settle-triggered
 * refresh this reuses. What is faked is the model, at the network boundary.
 *
 * "Re-read the rest of the inbox the moment you fix a title" (issue 399):
 * only a correction of a text Cockpit actually proposed re-reads anything
 * (`textCorrectionFor`, domain/text-corrections.ts) - clearing a title, or
 * writing one by hand from the start, teaches nothing and queues nothing.
 *
 * **Every setup capture and edit below runs with `ANTHROPIC_API_KEY`
 * deliberately unset**, and only set right before the one correction each
 * case is actually about. Both `enqueueCleanUp` (moment 2, on every capture)
 * and `enqueueReproposeTexts` (this job) are gated on that key, so setup
 * that ran with it absent queues nothing - no capture-time proposal races
 * the assertions below the way `repropose-panels.test.ts`'s own header
 * warns a shared model fake otherwise would.
 */
const A_KEY = 'a-key-that-proves-nothing-here';

/** A reading naming no panel - the field this job never writes, held fixed throughout. */
const proposing = (title: string, message = 'A fresh message') => ({
  language: 'English',
  title,
  message,
  readings: [] as unknown[],
  panel: { panelId: '', reason: '' },
});

type Answer = { says: unknown } | 'fails';
let answerFor: (note: string, system: string) => Answer = () => ({ says: proposing('A title') });
let asked: string[] = [];
let systemsSeen: string[] = [];

function stubTheModel(): void {
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
    const note = sent.messages[0]!.content;
    asked.push(note);
    systemsSeen.push(sent.system);

    const answer = answerFor(note, sent.system);
    if (answer === 'fails') throw new Error('the model could not be reached');
    return Response.json({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5',
      content: [{ type: 'text', text: JSON.stringify(answer.says) }],
      stop_reason: 'end_turn',
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
  return `018f0000-0000-7000-9100-${String(seq).padStart(12, '0')}`;
}

let issuedAtSeq = 0;
function nextIssuedAt(): string {
  issuedAtSeq += 1;
  return new Date(Date.parse('2026-09-11T10:00:00.000Z') + issuedAtSeq * 1000).toISOString();
}

async function captureANote(
  note: string,
  { workspaceId = WORKSPACE_ID, accountName = ACCOUNT_NAME }: { workspaceId?: string; accountName?: string } = {},
): Promise<string> {
  const itemId = nextId();
  const response = await postChange(
    'capture_item',
    {
      commandId: nextId(),
      issuedAt: nextIssuedAt(),
      workspaceId,
      itemId,
      message: note,
      typeId: taskTypeIn(accountName),
    },
    accountName === ACCOUNT_NAME ? undefined : OTHER_USER_ID,
  );
  expect(response.status).toBe(200);
  return itemId;
}

/**
 * Writes an Item directly with a proposal already standing on it - what
 * `applyProposedTexts` would have written, without spending a model call to
 * get there. Only an Item in this state has a correction to record
 * (`textCorrectionFor`), which is the precondition this whole job runs on.
 */
async function anItemAlreadyProposedFor(
  note: string,
  proposedTitle: string,
  { workspaceId = WORKSPACE_ID, accountName = ACCOUNT_NAME }: { workspaceId?: string; accountName?: string } = {},
): Promise<string> {
  const itemId = nextId();
  const when = nextIssuedAt();
  await inStoreAsItIs(accountName, (sql) =>
    sql.exec(
      `INSERT INTO items
         (id, tenant_id, workspace_id, source, captured_message, title, texts_proposed_at, status, unseen, created_at, updated_at)
       VALUES (?, ?, ?, 'internal', ?, ?, ?, 'to_process', 0, ?, ?)`,
      itemId,
      accountName,
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

async function correctTitle(itemId: string, title: string, { accountName = ACCOUNT_NAME }: { accountName?: string } = {}) {
  return postChange(
    'set_title',
    {
      commandId: nextId(),
      issuedAt: nextIssuedAt(),
      workspaceId: WORKSPACE_ID,
      itemId,
      title,
    },
    accountName === ACCOUNT_NAME ? undefined : OTHER_USER_ID,
  );
}

async function aPanel(name: string): Promise<string> {
  const panelId = nextId();
  const response = await postChange('add_panel', {
    commandId: nextId(),
    issuedAt: nextIssuedAt(),
    workspaceId: WORKSPACE_ID,
    dashboardId: `${WORKSPACE_ID}-dashboard-1`,
    panelId,
    name,
    kind: 'items',
  });
  expect(response.status).toBe(200);
  return panelId;
}

async function fileOnto(itemId: string, panelId: string): Promise<void> {
  const response = await postChange('add_item_to_panel', {
    commandId: nextId(),
    issuedAt: nextIssuedAt(),
    workspaceId: WORKSPACE_ID,
    itemId,
    panelId,
    order: [itemId],
  });
  expect(response.status).toBe(200);
}

async function titleOf(itemId: string, accountName: string = ACCOUNT_NAME): Promise<string> {
  const rows = await inStoreAsItIs(accountName, (sql) =>
    sql.exec<{ title: string }>('SELECT title FROM items WHERE id = ? AND tenant_id = ?', itemId, accountName).toArray(),
  );
  expect(rows).toHaveLength(1);
  return rows[0]!.title;
}

/** Waits for a re-read to have written this title. */
async function untilTitled(itemId: string, title: string, accountName: string = ACCOUNT_NAME): Promise<void> {
  await vi.waitFor(async () => expect(await titleOf(itemId, accountName)).toBe(title), {
    timeout: 15_000,
    interval: 50,
  });
}

/** A conservative stand-in for "nothing further happened": nothing left to wait for on purpose. */
async function aWhileLongerThanAJobWouldTake(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 300));
}

function batchOf(...jobs: EnrichmentJob[]) {
  const acked: string[] = [];
  const messages = jobs.map((job, index) => ({
    id: `message-${index + 1}`,
    timestamp: new Date(),
    body: job as unknown,
    attempts: 1,
    ack: () => acked.push(`message-${index + 1}`),
    retry: () => {},
  }));
  const batch = { queue: 'cockpit-enrichment', messages, ackAll: () => {}, retryAll: () => {} };
  return { batch: batch as unknown as Parameters<typeof handleQueue>[0], acked };
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  await alsoWorkspaces();
  answerFor = () => ({ says: proposing('A title') });
  asked = [];
  systemsSeen = [];
  env.ANTHROPIC_API_KEY = '';
  await signInAs();
  await signInAs(OTHER_USER_ID);
  stubTheModel();
});

afterEach(() => {
  env.ANTHROPIC_API_KEY = '';
  vi.unstubAllGlobals();
});

describe('Triage', () => {
  describe('correcting a text re-reads everything still unsettled in the Inbox', () => {
    it('re-proposes the other unfiled Items once a title is corrected', async () => {
      const waiting = await captureANote('a note about validation');
      const correcting = await anItemAlreadyProposedFor('call jan about the invoice', 'Call jan');
      answerFor = (note) =>
        note === 'a note about validation' ? { says: proposing('Validate the submission') } : { says: proposing('A title') };
      env.ANTHROPIC_API_KEY = A_KEY;

      const response = await correctTitle(correcting, 'Call Jan about the invoice');
      expect(response.status).toBe(200);
      expect((await response.json()) as { recordedCorrection?: boolean }).toMatchObject({
        recordedCorrection: true,
      });

      await untilTitled(waiting, 'Validate the submission');
    });

    it('a correction made through set_description re-reads the rest too', async () => {
      const waiting = await captureANote('a note about validation');
      const correcting = await anItemAlreadyProposedFor('call jan about the invoice', 'Call jan');
      answerFor = (note) =>
        note === 'a note about validation' ? { says: proposing('Validate the submission') } : { says: proposing('A title') };
      env.ANTHROPIC_API_KEY = A_KEY;

      const response = await postChange('set_description', {
        commandId: nextId(),
        issuedAt: nextIssuedAt(),
        workspaceId: WORKSPACE_ID,
        itemId: correcting,
        description: 'Ring Jan about the outstanding invoice',
      });
      expect(response.status).toBe(200);

      await untilTitled(waiting, 'Validate the submission');
    });

    it('leaves an Item whose texts you already settled untouched', async () => {
      const settled = await captureANote('already handled by hand');
      expect((await correctTitle(settled, 'Handled by hand')).status).toBe(200);
      const correcting = await anItemAlreadyProposedFor('call jan about the invoice', 'Call jan');
      env.ANTHROPIC_API_KEY = A_KEY;

      const response = await correctTitle(correcting, 'Call Jan about the invoice');
      expect(response.status).toBe(200);

      // Both `settled` and `correcting` are settled the moment this lands, so
      // the re-read finds no candidate at all and asks the model nothing -
      // true regardless of timing, not a race this waits out.
      await aWhileLongerThanAJobWouldTake();
      expect(asked).toEqual([]);
      expect(await titleOf(settled)).toBe('Handled by hand');
    });

    it('leaves an Item already filed onto a Panel untouched', async () => {
      const panel = await aPanel('Compliance questions');
      const filed = await captureANote('a note about validation');
      await fileOnto(filed, panel);
      const correcting = await anItemAlreadyProposedFor('call jan about the invoice', 'Call jan');
      env.ANTHROPIC_API_KEY = A_KEY;

      const response = await correctTitle(correcting, 'Call Jan about the invoice');
      expect(response.status).toBe(200);

      await aWhileLongerThanAJobWouldTake();
      expect(asked).toEqual([]);
    });

    it('does not re-read the Item you just corrected - it is settled by definition', async () => {
      const correcting = await anItemAlreadyProposedFor('call jan about the invoice', 'Call jan');
      env.ANTHROPIC_API_KEY = A_KEY;

      const response = await correctTitle(correcting, 'Call Jan about the invoice');
      expect(response.status).toBe(200);

      // The only unsettled Item in the account is the one just corrected, so
      // the re-read finds nothing left and fails on nothing either.
      await aWhileLongerThanAJobWouldTake();
      expect(asked).toEqual([]);
      expect(await titleOf(correcting)).toBe('Call Jan about the invoice');
    });

    it("leaves another account's Items untouched", async () => {
      const overThere = await captureANote('a note in the other account', { accountName: OTHER_ACCOUNT_NAME });
      const correcting = await anItemAlreadyProposedFor('call jan about the invoice', 'Call jan');
      env.ANTHROPIC_API_KEY = A_KEY;

      const response = await correctTitle(correcting, 'Call Jan about the invoice');
      expect(response.status).toBe(200);

      await aWhileLongerThanAJobWouldTake();
      expect(asked).toEqual([]);
      expect(await titleOf(overThere, OTHER_ACCOUNT_NAME)).toBe('a note in the other account');
    });
  });

  describe('the re-read is read against the correction that caused it', () => {
    it('builds the new proposals with the correction among the inputs', async () => {
      const waiting = await captureANote('a note about validation');
      const correcting = await anItemAlreadyProposedFor('call jan about the invoice', 'Call jan');
      answerFor = (note) =>
        note === 'a note about validation' ? { says: proposing('Validate the submission') } : { says: proposing('A title') };
      env.ANTHROPIC_API_KEY = A_KEY;

      const response = await correctTitle(correcting, 'Call Jan about the invoice, today');
      expect(response.status).toBe(200);

      await untilTitled(waiting, 'Validate the submission');
      expect(
        systemsSeen.some((system) => system.includes('"Call jan" became "Call Jan about the invoice, today"')),
      ).toBe(true);
    });
  });

  describe('the honest edges', () => {
    it("one Item's failure during a re-read does not stop the rest from being re-proposed", async () => {
      const failing = await captureANote('a note that fails');
      const waiting = await captureANote('a note about validation');
      const correcting = await anItemAlreadyProposedFor('call jan about the invoice', 'Call jan');
      answerFor = (note) => {
        if (note === 'a note that fails') return 'fails';
        if (note === 'a note about validation') return { says: proposing('Validate the submission') };
        return { says: proposing('A title') };
      };
      env.ANTHROPIC_API_KEY = A_KEY;

      const response = await correctTitle(correcting, 'Call Jan about the invoice');
      expect(response.status).toBe(200);

      await untilTitled(waiting, 'Validate the submission');
      // `failing` keeps the mechanical title capture wrote - a failed call
      // costs nothing but a retry the real queue never delivers in this test.
      expect(await titleOf(failing)).toBe('a note that fails');
    });

    it('correcting several titles in a minute queues a fan-out each, not a debounced one', async () => {
      const waiting = await captureANote('a note only this re-read ever asks about');
      const first = await anItemAlreadyProposedFor('call jan about the invoice', 'Call jan');
      const second = await anItemAlreadyProposedFor('email priya about the contract', 'Email priya');
      env.ANTHROPIC_API_KEY = A_KEY;
      answerFor = (note) =>
        note === 'a note only this re-read ever asks about'
          ? { says: proposing('Re-read again') }
          : { says: proposing('A title') };

      expect((await correctTitle(first, 'Call Jan about the invoice')).status).toBe(200);
      await untilTitled(waiting, 'Re-read again');
      const askedSoFar = asked.filter((note) => note === 'a note only this re-read ever asks about').length;
      answerFor = (note) =>
        note === 'a note only this re-read ever asks about'
          ? { says: proposing('Re-read once more') }
          : { says: proposing('A title') };

      expect((await correctTitle(second, 'Email Priya about the contract')).status).toBe(200);

      await untilTitled(waiting, 'Re-read once more');
      expect(
        asked.filter((note) => note === 'a note only this re-read ever asks about').length,
      ).toBeGreaterThan(askedSoFar);
    });

    it('several corrections landing in the same batch fire one re-read, not one per correction', async () => {
      const waiting = await captureANote('a note only this re-read ever asks about');
      env.ANTHROPIC_API_KEY = A_KEY;
      answerFor = (note) =>
        note === 'a note only this re-read ever asks about' ? { says: proposing('Re-read once') } : { says: proposing('A title') };

      const { batch, acked } = batchOf(
        { kind: 're-propose-texts', accountName: ACCOUNT_NAME },
        { kind: 're-propose-texts', accountName: ACCOUNT_NAME },
        { kind: 're-propose-texts', accountName: ACCOUNT_NAME },
      );

      await handleQueue(batch, env);

      expect(acked.sort()).toEqual(['message-1', 'message-2', 'message-3']);
      expect(asked.filter((note) => note === 'a note only this re-read ever asks about')).toHaveLength(1);
      expect(await titleOf(waiting)).toBe('Re-read once');
    });

    it('a re-read with nothing left unsettled asks the model nothing, and fails on nothing', async () => {
      env.ANTHROPIC_API_KEY = A_KEY;
      const { batch, acked } = batchOf({ kind: 're-propose-texts', accountName: ACCOUNT_NAME });

      await handleQueue(batch, env);

      expect(acked).toEqual(['message-1']);
      expect(asked).toEqual([]);
    });

    it('an edit that clears a title records no correction and queues no re-read', async () => {
      const waiting = await captureANote('a note about validation');
      const correcting = await anItemAlreadyProposedFor('call jan about the invoice', 'Call jan');
      env.ANTHROPIC_API_KEY = A_KEY;

      const response = await correctTitle(correcting, '   ');
      expect(response.status).toBe(200);
      expect((await response.json()) as { recordedCorrection?: boolean }).not.toMatchObject({
        recordedCorrection: true,
      });

      await aWhileLongerThanAJobWouldTake();
      expect(asked).toEqual([]);
      expect(await titleOf(waiting)).toBe('a note about validation');
    });

    it('an edit to an Item Cockpit never proposed for records no correction and queues no re-read', async () => {
      const waiting = await captureANote('a note about validation');
      const typedByHand = await captureANote('typed straight in, never enriched');
      env.ANTHROPIC_API_KEY = A_KEY;

      const response = await correctTitle(typedByHand, 'Renamed by hand');
      expect(response.status).toBe(200);
      expect((await response.json()) as { recordedCorrection?: boolean }).not.toMatchObject({
        recordedCorrection: true,
      });

      await aWhileLongerThanAJobWouldTake();
      expect(asked).toEqual([]);
      expect(await titleOf(waiting)).toBe('a note about validation');
    });
  });
});
