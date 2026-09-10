import { beforeEach, afterEach, describe, expect, inject, it, vi } from 'vitest';
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
 * Integration level: a real store, a real queue, and the settling filing
 * arrives through the real Worker (`SELF.fetch`, via `asUser`) - the same
 * shape `note-cleanup.test.ts` already exercises for the classification
 * this refresh reuses. What is faked is the model, at the network boundary.
 *
 * "Re-propose the rest of the inbox the moment you file one" (issue 300):
 * `docs/routing-learning.md`'s inbox-open refresh (moment 3) is not built by
 * this and is not what fires below - what fires is a settle (moment 4).
 *
 * **Every captured note gets its own moment-2 classification call too** -
 * `enqueueCleanUp` fires on every `capture_item`, real queue and all - so the
 * model fake below answers *any* note it is asked about, not only the ones a
 * case cares about, and cases that care what a note's *own* first call
 * proposes decide the answer from the system prompt's own decision history
 * rather than from when in the test they happen to be asked: the history
 * only grows once a filing has genuinely settled, so a note asked about
 * before that has nothing in it to answer from, and a note asked about after
 * does - independent of which job happened to ask.
 */

const WS2 = 'ws-atlas';

/** A reading naming a panel, everything else held fixed since only `panel` is ever read here. */
const proposing = (panelId: string, reason = 'because') => ({
  language: 'English',
  title: 'A title',
  message: 'A message',
  readings: [] as unknown[],
  panel: { panelId, reason },
});
/** A reading naming no panel - the common, welcome answer, and the default every note gets. */
const PROPOSES_NOTHING = {
  language: 'English',
  title: 'A title',
  message: 'A message',
  readings: [] as unknown[],
  panel: { panelId: '', reason: '' },
};

type Answer = { says: unknown } | 'fails';
let answerFor: (note: string, system: string) => Answer = () => ({ says: PROPOSES_NOTHING });
let asked: string[] = [];

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
  return `018f0000-0000-7000-9000-${String(seq).padStart(12, '0')}`;
}

/**
 * A strictly increasing timestamp, one per call - `createdAt` is the client's
 * own `issuedAt` (`captureItem`, apps/api/src/domain/items.ts), so two
 * captures sharing one literal share one `created_at` too, and
 * `unfiledItemsInWorkspace`'s `ORDER BY created_at DESC` has nothing left to
 * break the tie by. Every case here that reasons about which candidate a
 * refresh reaches first needs that order to actually follow capture order.
 */
let issuedAtSeq = 0;
function nextIssuedAt(): string {
  issuedAtSeq += 1;
  return new Date(Date.parse('2026-09-10T10:00:00.000Z') + issuedAtSeq * 1000).toISOString();
}

async function captureANote(
  note: string,
  { workspaceId = WORKSPACE_ID, decided = true }: { workspaceId?: string; decided?: boolean } = {},
): Promise<string> {
  const itemId = nextId();
  const response = await postChange('capture_item', {
    commandId: nextId(),
    issuedAt: nextIssuedAt(),
    workspaceId,
    itemId,
    message: note,
    typeId: TASK_TYPE_ID,
    workspaceDecided: decided,
  });
  expect(response.status).toBe(200);
  return itemId;
}

async function aPanel(name: string, dashboardId = DASHBOARD_ID, workspaceId = WORKSPACE_ID): Promise<string> {
  const panelId = nextId();
  const response = await postChange('add_panel', {
    commandId: nextId(),
    issuedAt: '2026-09-10T10:00:00.000Z',
    workspaceId,
    dashboardId,
    panelId,
    name,
    kind: 'items',
  });
  expect(response.status).toBe(200);
  return panelId;
}

async function moveOnto(itemId: string, panelId: string, workspaceId = WORKSPACE_ID): Promise<void> {
  const response = await postChange('move_item_to_panel', {
    commandId: nextId(),
    issuedAt: '2026-09-10T10:00:01.000Z',
    workspaceId,
    itemId,
    panelId,
    order: [itemId],
  });
  expect(response.status).toBe(200);
}

async function fileOnto(itemId: string, panelId: string, workspaceId = WORKSPACE_ID): Promise<void> {
  const response = await postChange('add_item_to_panel', {
    commandId: nextId(),
    issuedAt: '2026-09-10T10:00:01.000Z',
    workspaceId,
    itemId,
    panelId,
    order: [itemId],
  });
  expect(response.status).toBe(200);
}

async function moveToInbox(itemId: string, workspaceId = WORKSPACE_ID): Promise<void> {
  const response = await postChange('move_item_to_panel', {
    commandId: nextId(),
    issuedAt: '2026-09-10T10:00:01.000Z',
    workspaceId,
    itemId,
    panelId: null,
    order: [],
  });
  expect(response.status).toBe(200);
}

async function routingOf(itemId: string): Promise<string | null> {
  const rows = await inStoreAsItIs(ACCOUNT_NAME, (sql) =>
    sql
      .exec<{ proposed_panel_id: string | null }>(
        'SELECT proposed_panel_id FROM items WHERE id = ? AND tenant_id = ?',
        itemId,
        ACCOUNT_NAME,
      )
      .toArray(),
  );
  return rows[0]?.proposed_panel_id ?? null;
}

/** Waits for a refresh to have written this proposal - the completion signal every case waits on. */
async function untilRouted(itemId: string, panelId: string): Promise<void> {
  await vi.waitFor(async () => expect(await routingOf(itemId)).toBe(panelId), {
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
  answerFor = () => ({ says: PROPOSES_NOTHING });
  asked = [];
  env.ANTHROPIC_API_KEY = 'a-key-that-proves-nothing-here';
  await signInAs();
  stubTheModel();
});

afterEach(() => {
  env.ANTHROPIC_API_KEY = '';
  vi.unstubAllGlobals();
});

describe('Triage', () => {
  describe('a settled filing re-proposes the panel for every other unsettled item in its workspace', () => {
    it('moving an item onto a panel for the first time refreshes the rest of the Inbox', async () => {
      const compliance = await aPanel('Compliance questions');
      const elsewhere = await aPanel('Somewhere else');
      answerFor = (note, system) =>
        note === 'a note about validation' && system.includes('Somewhere else')
          ? { says: proposing(compliance, 'a compliance question') }
          : { says: PROPOSES_NOTHING };
      const waiting = await captureANote('a note about validation');
      const settling = await captureANote('call jan about the invoice');

      await moveOnto(settling, elsewhere);

      await untilRouted(waiting, compliance);
    });

    it('adding an item to a panel for the first time refreshes the rest of the Inbox, the same as a move', async () => {
      const compliance = await aPanel('Compliance questions');
      const elsewhere = await aPanel('Somewhere else');
      answerFor = (note, system) =>
        note === 'a note about validation' && system.includes('Somewhere else')
          ? { says: proposing(compliance, 'a compliance question') }
          : { says: PROPOSES_NOTHING };
      const waiting = await captureANote('a note about validation');
      const settling = await captureANote('call jan about the invoice');

      await fileOnto(settling, elsewhere);

      await untilRouted(waiting, compliance);
    });

    it('a reorganizing move of an already-filed item refreshes nothing', async () => {
      const compliance = await aPanel('Compliance questions');
      const elsewhere = await aPanel('Somewhere else');
      const another = await aPanel('Another panel');
      answerFor = (note, system) =>
        note === 'a note about validation' && system.includes('Somewhere else')
          ? { says: proposing(compliance, 'a compliance question') }
          : { says: PROPOSES_NOTHING };
      const waiting = await captureANote('a note about validation');
      const settled = await captureANote('call jan about the invoice');
      await moveOnto(settled, elsewhere);
      await untilRouted(waiting, compliance);
      asked = [];

      await moveOnto(settled, another);

      await aWhileLongerThanAJobWouldTake();
      expect(asked).toEqual([]);
    });

    it('moving an item back to the Inbox refreshes nothing - it never settles a routing', async () => {
      const compliance = await aPanel('Compliance questions');
      const elsewhere = await aPanel('Somewhere else');
      answerFor = (note, system) =>
        note === 'a note about validation' && system.includes('Somewhere else')
          ? { says: proposing(compliance, 'a compliance question') }
          : { says: PROPOSES_NOTHING };
      const waiting = await captureANote('a note about validation');
      const settled = await captureANote('call jan about the invoice');
      await moveOnto(settled, elsewhere);
      await untilRouted(waiting, compliance);
      asked = [];

      await moveToInbox(settled);

      await aWhileLongerThanAJobWouldTake();
      expect(asked).toEqual([]);
    });

    it('adding an already-filed item to a second panel refreshes nothing', async () => {
      const compliance = await aPanel('Compliance questions');
      const elsewhere = await aPanel('Somewhere else');
      const another = await aPanel('Another panel');
      answerFor = (note, system) =>
        note === 'a note about validation' && system.includes('Somewhere else')
          ? { says: proposing(compliance, 'a compliance question') }
          : { says: PROPOSES_NOTHING };
      const waiting = await captureANote('a note about validation');
      const settled = await captureANote('call jan about the invoice');
      await moveOnto(settled, elsewhere);
      await untilRouted(waiting, compliance);
      asked = [];

      await fileOnto(settled, another);

      await aWhileLongerThanAJobWouldTake();
      expect(asked).toEqual([]);
    });
  });

  describe('a refresh only touches the workspace it was triggered from, and the items still undecided between all of them', () => {
    it('leaves an item of a different workspace untouched', async () => {
      const compliance = await aPanel('Compliance questions');
      const elsewhere = await aPanel('Somewhere else');
      answerFor = (note, system) =>
        note === 'a note about validation' && system.includes('Somewhere else')
          ? { says: proposing(compliance, 'a compliance question') }
          : { says: PROPOSES_NOTHING };
      const waiting = await captureANote('a note about validation');
      const unrelated = await captureANote('a note in the other workspace', { workspaceId: WS2 });
      const settling = await captureANote('call jan about the invoice');

      await moveOnto(settling, elsewhere);

      await untilRouted(waiting, compliance);
      // Waiting for the whole refresh to settle, not only `waiting`'s own
      // row: `unrelated` is asked about exactly once, from its own capture,
      // regardless of the order the refresh's candidates are read in - a
      // count of two would mean the refresh wrongly picked it up as well.
      await aWhileLongerThanAJobWouldTake();
      expect(asked.filter((note) => note === 'a note in the other workspace')).toHaveLength(1);
      expect(await routingOf(unrelated)).toBeNull();
    });

    it('refreshes an item still undecided between workspaces, regardless of which workspace the settle happened in', async () => {
      const compliance = await aPanel('Compliance questions', `${WS2}-dashboard-1`, WS2);
      const elsewhere = await aPanel('Somewhere else');
      // Captured from Workspace 2's own context (its own Panels are what its
      // classification reads, matching moment 2 exactly - the same
      // `candidate.workspaceId` `reproposePanels` itself reads) - so nothing
      // about *what* it is asked differs between its own capture-time call
      // and a refresh's: Workspace 1's settle below never touches Workspace
      // 2's own history. What differs is *whether it is asked a second time
      // at all*, which is what this counts instead.
      let timesAsked = 0;
      answerFor = (note) => {
        if (note !== 'a note about validation') return { says: PROPOSES_NOTHING };
        timesAsked += 1;
        return timesAsked === 1 ? { says: PROPOSES_NOTHING } : { says: proposing(compliance, 'a compliance question') };
      };
      // Undecided, so it is still shown in Workspace 1's Inbox too ("Capture
      // something before you know which workspace it belongs to", issue 165)
      // - and is what this refresh, triggered there, has to pick up.
      const undecided = await captureANote('a note about validation', { workspaceId: WS2, decided: false });
      const settling = await captureANote('call jan about the invoice');

      await moveOnto(settling, elsewhere);

      await untilRouted(undecided, compliance);
    });
  });

  describe('the honest edges', () => {
    it('a refresh with nothing left unsettled asks the model nothing', async () => {
      const elsewhere = await aPanel('Somewhere else');
      const settling = await captureANote('call jan about the invoice');
      asked = [];

      await moveOnto(settling, elsewhere);

      await aWhileLongerThanAJobWouldTake();
      expect(asked).toEqual([]);
    });

    it("one item's failure during a refresh does not stop the rest from being reclassified", async () => {
      const compliance = await aPanel('Compliance questions');
      const elsewhere = await aPanel('Somewhere else');
      // Fails only once the history mentions the settle below, so its own
      // capture-time classification (moment 2, asked before that exists)
      // succeeds cleanly - never entering the queue's own 60-second retry,
      // which would otherwise leave this case's background work still
      // running well after it returns and free to pollute the next case's
      // `asked`/`answerFor` (both closed over by the one stubbed `fetch`).
      answerFor = (note, system) => {
        if (note === 'a note that fails') return system.includes('Somewhere else') ? 'fails' : { says: PROPOSES_NOTHING };
        return note === 'a note about validation' && system.includes('Somewhere else')
          ? { says: proposing(compliance, 'a compliance question') }
          : { says: PROPOSES_NOTHING };
      };
      await captureANote('a note that fails');
      const waiting = await captureANote('a note about validation');
      const settling = await captureANote('call jan about the invoice');

      await moveOnto(settling, elsewhere);

      await untilRouted(waiting, compliance);
      // `waiting` is the more recently captured of the two candidates, so a
      // refresh reaches it first and the failing item second - waited for
      // here too, so the whole refresh has actually finished (not merely
      // written what this case checks) before the next case starts.
      await vi.waitFor(
        async () => expect(asked.filter((note) => note === 'a note that fails').length).toBeGreaterThanOrEqual(2),
        { timeout: 15_000, interval: 50 },
      );
    });

    it('filing several items in quick succession fires one refresh for the workspace, not one per item', async () => {
      const compliance = await aPanel('Compliance questions');
      answerFor = (note) => (note === 'a note only this refresh ever asks about' ? { says: proposing(compliance, 'because') } : { says: PROPOSES_NOTHING });
      // Written directly, with no `capture_item` behind it, so the only thing
      // that ever asks the model about this note is the refresh under test -
      // a capture's own moment-2 classification, fired on the real queue and
      // not awaited by any helper here, would otherwise be a second, racy
      // source of the same note text the assertions below count.
      const waiting = nextId();
      await inStoreAsItIs(ACCOUNT_NAME, (sql) =>
        sql.exec(
          `INSERT INTO items (id, tenant_id, workspace_id, source, captured_message, title, status, unseen, created_at, updated_at)
           VALUES (?, ?, ?, 'internal', ?, 'Typed by hand', 'to_process', 0, ?, ?)`,
          waiting,
          ACCOUNT_NAME,
          WORKSPACE_ID,
          'a note only this refresh ever asks about',
          nextIssuedAt(),
          nextIssuedAt(),
        ),
      );

      // Three duplicate settle-triggered jobs for the same account and
      // workspace, as several near-simultaneous filings would each enqueue -
      // sent as one batch, the way they would land in the real queue's own
      // one-second window (wrangler.jsonc), and driven straight through
      // `handleQueue` rather than waited out through that real timing.
      const { batch, acked } = batchOf(
        { kind: 're-propose-panels', accountName: ACCOUNT_NAME, workspaceId: WORKSPACE_ID },
        { kind: 're-propose-panels', accountName: ACCOUNT_NAME, workspaceId: WORKSPACE_ID },
        { kind: 're-propose-panels', accountName: ACCOUNT_NAME, workspaceId: WORKSPACE_ID },
      );

      await handleQueue(batch, env);

      // All three are acknowledged - the two duplicates by the dedup step,
      // the survivor by `workThrough` once it has actually run - but only
      // the survivor ever reaches the model.
      expect(acked.sort()).toEqual(['message-1', 'message-2', 'message-3']);
      expect(asked.filter((note) => note === 'a note only this refresh ever asks about')).toHaveLength(1);
      expect(await routingOf(waiting)).toBe(compliance);
    });

    it('leaves an item with no captured note out of a refresh', async () => {
      const compliance = await aPanel('Compliance questions');
      const elsewhere = await aPanel('Somewhere else');
      answerFor = (note, system) =>
        note === 'a note about validation' && system.includes('Somewhere else')
          ? { says: proposing(compliance, 'a compliance question') }
          : { says: PROPOSES_NOTHING };
      const waiting = await captureANote('a note about validation');
      // No captured note reaches the client route, so this writes one
      // directly - the same case `note-cleanup.test.ts` cannot drive through
      // the HTTP layer either, for the same reason.
      const bare = nextId();
      await inStoreAsItIs(ACCOUNT_NAME, (sql) =>
        sql.exec(
          `INSERT INTO items (id, tenant_id, workspace_id, source, title, status, unseen, created_at, updated_at)
           VALUES (?, ?, ?, 'internal', 'Typed by hand', 'to_process', 0, ?, ?)`,
          bare,
          ACCOUNT_NAME,
          WORKSPACE_ID,
          '2026-09-10T10:00:00.000Z',
          '2026-09-10T10:00:00.000Z',
        ),
      );
      const settling = await captureANote('call jan about the invoice');

      await moveOnto(settling, elsewhere);

      await untilRouted(waiting, compliance);
      expect(await routingOf(bare)).toBeNull();
    });

    it('refreshes an item filed only on a since-deleted panel, rather than skipping it forever', async () => {
      const compliance = await aPanel('Compliance questions');
      const elsewhere = await aPanel('Somewhere else');
      const temporary = await aPanel('Temporary');
      answerFor = (note, system) =>
        note === 'a note about validation' && system.includes('Somewhere else')
          ? { says: proposing(compliance, 'a compliance question') }
          : { says: PROPOSES_NOTHING };
      const waiting = await captureANote('a note about validation');
      // Settled once already, onto a Panel that is about to go - the same
      // "back in the Inbox" case `isItemFiled` itself carries a comment for:
      // a tombstoned Panel leaves its `panel_items` row untouched.
      await moveOnto(waiting, temporary);
      const deleteResponse = await postChange('delete_panel', {
        commandId: nextId(),
        issuedAt: '2026-09-10T10:00:02.000Z',
        workspaceId: WORKSPACE_ID,
        panelId: temporary,
      });
      expect(deleteResponse.status).toBe(200);
      const settling = await captureANote('call jan about the invoice');

      await moveOnto(settling, elsewhere);

      await untilRouted(waiting, compliance);
    });

    it('withdraws a stale proposal once a refresh concludes nothing fits any more', async () => {
      const compliance = await aPanel('Compliance questions');
      const elsewhere = await aPanel('Somewhere else');
      // Written directly, with a proposal from an earlier round already
      // standing on it and no `capture_item` behind it at all - only the
      // refresh under test ever reads this item, so there is no capture-time
      // moment-2 job racing to withdraw the same proposal itself and leaving
      // the assertion below unable to tell which of the two did it.
      const waiting = nextId();
      await inStoreAsItIs(ACCOUNT_NAME, (sql) =>
        sql.exec(
          `INSERT INTO items
             (id, tenant_id, workspace_id, source, captured_message, title, status, unseen,
              proposed_panel_id, proposed_panel_reason, created_at, updated_at)
           VALUES (?, ?, ?, 'internal', ?, 'Typed by hand', 'to_process', 0, ?, 'a compliance question', ?, ?)`,
          waiting,
          ACCOUNT_NAME,
          WORKSPACE_ID,
          'a note that will not fit any more',
          compliance,
          nextIssuedAt(),
          nextIssuedAt(),
        ),
      );
      const settling = await captureANote('call jan about the invoice');

      await moveOnto(settling, elsewhere);

      await vi.waitFor(async () => expect(await routingOf(waiting)).toBeNull(), {
        timeout: 15_000,
        interval: 50,
      });
    });
  });
});
