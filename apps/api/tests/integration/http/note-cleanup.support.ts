import { beforeEach, afterEach, describe, expect, inject, it, vi } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { ACCOUNT_WIDE, type CommandName, type CommandPayload } from '@cockpit/shared';
import {
  ACCOUNT_NAME,
  DASHBOARD_ID,
  OTHER_ACCOUNT_NAME,
  OTHER_USER_ID,
  TASK_TYPE_ID,
  WORKSPACE_ID,
  alsoWorkspaces,
  asUser,
  inStoreAsItIs,
  inTheStore,
  seedRegister,
  signInAs,
  startFromEmpty,
  storeNamed,
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
 * (tests/contract/clean-up-a-note.v16.test.ts).
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

export const NOTE = 'part 11 audit trail q for validation protocol, who signs off eod';
export const A_READING = {
  language: 'English',
  title: 'Part 11 audit trail question for the validation protocol',
  message:
    'A question about the Part 11 audit trail, for the validation protocol. Needs to be clear by end of day who signs off on it; the note does not say who that is.',
  readings: [] as unknown[],
};

/** A second, different reading, so a case can tell "not rewritten" from "rewritten the same way". */
export const SOMETHING_ELSE = {
  language: 'English',
  title: 'Something else entirely',
  message: 'A completely different reading of the same note.',
  readings: [] as unknown[],
};

/**
 * A note that genuinely reads two ways ("Offer the other readings when a
 * captured note says two things", issue 297) - the POC's own proof, `call
 * jan`, though what is actually read here is `NOTE` above; the model's
 * answer, not the note it was asked about, is what a fake stands in for.
 */
export const AMBIGUOUS_NOTE = {
  language: 'English',
  title: 'Call Jan',
  message: 'Call Jan.',
  readings: [{ title: 'Call in January', message: '', meaning: "'jan' is short for January" }],
};

/** What the model does when it is asked. */
export type Answering =
  | { says: unknown }
  // Answers by what is being asked, for a case where one capture makes two different calls.
  | { by: (call: { system: string }) => unknown }
  | { text: string }
  | 'fails'
  | 'declines';

export const asked: { system: string; note: string; blocks: { text: string; cache_control?: unknown }[]; model: string }[] = [];

/**
 * What happens between the note being sent and the answer coming back - which
 * is the only way to reach the window an edit can land in: a person typing
 * while the model is reading.
 */
export const reading: { during: ((call: { system: string }) => Promise<unknown>) | null } = { during: null };

/**
 * Puts a model on the network, and refuses every other address - so a case that
 * starts talking to the real internet says so instead of quietly costing money.
 */
export function theModelIs(answering: Answering): void {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.hostname !== 'api.anthropic.com') {
      throw new Error(`the suite tried to reach ${url.origin}`);
    }

    const sent = JSON.parse(
      input instanceof Request ? await input.clone().text() : String(init?.body ?? '{}'),
    ) as { model: string; system: { text: string; cache_control?: unknown }[]; messages: { content: string }[] };
    // Sent as blocks, the fixed half first and cached ("Enable prompt caching on the note-cleanup prompt", issue 584);
    // read here as the one text the model sees.
    const system = sent.system.map((block) => block.text).join('\n\n');
    asked.push({ system, note: sent.messages[0]!.content, blocks: sent.system, model: sent.model });

    if (reading.during) await reading.during({ system });

    if (answering === 'fails') throw new Error('the model could not be reached');
    return Response.json({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5',
      content:
        answering === 'declines'
          ? []
          : [
              {
                type: 'text',
                text:
                  'text' in answering
                    ? answering.text
                    : JSON.stringify('by' in answering ? answering.by({ system }) : answering.says),
              },
            ],
      stop_reason: answering === 'declines' ? 'refusal' : 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  });
}

export async function postChange<N extends CommandName>(name: N, payload: CommandPayload<N>, userId?: string) {
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
export function nextId(): string {
  seq += 1;
  return `018f0000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
}

export async function captureANote(
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
export async function textsOf(itemId: string, accountName = ACCOUNT_NAME) {
  const rows = await inStoreAsItIs(accountName, (sql) =>
    sql
      .exec<{
        title: string;
        description: string | null;
        captured_message: string | null;
        readings: string | null;
      }>(
        'SELECT title, description, captured_message, readings FROM items WHERE id = ? AND tenant_id = ?',
        itemId,
        accountName,
      )
      .toArray(),
  );
  const row = rows[0];
  return row && { ...row, readings: row.readings ? JSON.parse(row.readings) : null };
}

/**
 * Waits for the note to have been read, which happens after the capture has
 * been answered and is what the whole feature is: capture never waits on it.
 */
export async function untilTheNoteHasBeenRead(itemId: string): Promise<void> {
  await vi.waitFor(
    async () => {
      expect((await textsOf(itemId))?.title).toBe(A_READING.title);
    },
    { timeout: 15_000, interval: 50 },
  );
}

/**
 * Captures a fresh note against whatever fixture rows a case has already set
 * up, and waits for the read that follows - the shape every case in this file
 * that asserts on `asked[0].system` against pre-arranged evidence shares,
 * rather than each spelling out its own `asked = []`/`vi.waitFor` pair.
 */
export async function readAgain(): Promise<void> {
  asked.length = 0;
  await captureANote({ itemId: nextId() });
  await vi.waitFor(() => expect(asked.some(isACleanUp)).toBe(true), { timeout: 15_000, interval: 50 });
  // A refresh a filing queued earlier can still be asking the model about
  // where an item belongs; it is not the read this case asserts on.
  asked.splice(0, asked.length, ...asked.filter(isACleanUp));
}

/** Whether a call is a note being cleaned up, by the worked examples only that prompt carries. */
export const isACleanUp = (call: { system: string }) => call.system.includes('Examples.');

/** Whether a call is the read of which places a note's words mean, by the list of names only that prompt carries. */
export const isAPlaceRead = (call: { system: string }) => call.system.includes('Places:');

/** Whether a call is a Panel being chosen for an item, which is every call that is neither of the two above. */
export const isAPanelChoice = (call: { system: string }) => !isACleanUp(call) && !isAPlaceRead(call);

/** What `reading.during` runs: `meanwhile`, during the first call of the kind `which` picks out, and during no other. */
export function duringThe(
  which: (call: { system: string }) => boolean,
  meanwhile: () => Promise<unknown>,
): (call: { system: string }) => Promise<unknown> {
  let ran = false;
  return async (call) => {
    if (ran || !which(call)) return;
    ran = true;
    await meanwhile();
  };
}

/** The names the read of a note's place words answers with; each left out names nothing. */
export interface PlaceAnswer {
  workspace?: string;
  dashboard?: string;
  panels?: string[];
}

/**
 * The calls one capture naming a place makes ("File a capture on the panels
 * you name, read from the spoken path", issue 1116): the clean-up, which gives
 * the words, and the read of which names they mean - or, with `place` null, a
 * clean-up giving no words. `cleanUp` rides on the first, and `choosing`
 * answers a Panel choice for the workspace the item moved to.
 */
export function theModelReadsAPlace(
  place: PlaceAnswer | 'fails' | null,
  { cleanUp = {}, choosing = null }: { cleanUp?: object; choosing?: unknown } = {},
): void {
  theModelIs({
    by: (call) => {
      if (isACleanUp(call)) return { ...A_READING, ...cleanUp, ...(place === null ? {} : { place: 'the words saying where' }) };
      if (!isAPlaceRead(call)) return choosing;
      if (place === 'fails') throw new Error('the model could not be reached');
      return { workspace: place?.workspace ?? '', dashboard: place?.dashboard ?? '', panels: place?.panels ?? [] };
    },
  });
}

/** The Panels an item is filed on, each with its place there, read straight out of the store. */
export async function panelsHolding(itemId: string): Promise<{ panelId: string; position: number }[]> {
  const rows = await inStoreAsItIs(ACCOUNT_NAME, (sql) =>
    sql
      .exec<{ panel_id: string; position: number }>(
        'SELECT panel_id, position FROM panel_items WHERE item_id = ? AND tenant_id = ? ORDER BY panel_id',
        itemId,
        ACCOUNT_NAME,
      )
      .toArray(),
  );
  return rows.map((row) => ({ panelId: row.panel_id, position: row.position }));
}

/** The settled routings recorded for an item, read straight out of the store. */
export async function decisionsOn(itemId: string) {
  return inStoreAsItIs(ACCOUNT_NAME, (sql) =>
    sql
      .exec<{ workspace_id: string; chosen_panel_id: string; proposed_panel_id: string | null; proposed_panel_fit: string | null }>(
        'SELECT workspace_id, chosen_panel_id, proposed_panel_id, proposed_panel_fit FROM decision_history WHERE item_id = ? AND tenant_id = ?',
        itemId,
        ACCOUNT_NAME,
      )
      .toArray(),
  );
}

/**
 * The routing Cockpit proposed for an item, read straight out of the store -
 * the panel half of "Propose where a captured note belongs, without filing it
 * there" (issue 298), beside `textsOf` above.
 */
export async function routingOf(itemId: string, accountName = ACCOUNT_NAME) {
  const rows = await inStoreAsItIs(accountName, (sql) =>
    sql
      .exec<{ proposed_panel_id: string | null; proposed_panel_reason: string | null }>(
        'SELECT proposed_panel_id, proposed_panel_reason FROM items WHERE id = ? AND tenant_id = ?',
        itemId,
        accountName,
      )
      .toArray(),
  );
  return rows[0] ?? null;
}

/**
 * The Panel an Item is proposed and how sure that is, as the Inbox reads them -
 * through its Workspace's snapshot ("Propose the closest Panel at capture, and
 * draw a less certain one dashed", issue 1107).
 */
export async function proposalShownFor(itemId: string, workspaceId = WORKSPACE_ID) {
  const response = await asUser(`http://cockpit.test/v1/workspaces/${workspaceId}/snapshot`);
  expect(response.status).toBe(200);
  const held = (await response.json()) as {
    items: { id: string; proposedPanelId: string | null; proposedPanelFit: string | null }[];
  };
  const item = held.items.find((one) => one.id === itemId);
  return item && { proposedPanelId: item.proposedPanelId, proposedPanelFit: item.proposedPanelFit };
}

/** An item's priority and when the person last made it their own, read straight out of the store. */
export async function priorityOf(itemId: string) {
  const rows = await inStoreAsItIs(ACCOUNT_NAME, (sql) =>
    sql
      .exec<{ priority: string | null; priority_set_at: string | null }>(
        'SELECT priority, priority_set_at FROM items WHERE id = ? AND tenant_id = ?',
        itemId,
        ACCOUNT_NAME,
      )
      .toArray(),
  );
  return rows[0] ?? null;
}

/** What Cockpit changed on one item, newest first, as its own tab reads it. */
export async function historyOf(
  itemId: string,
): Promise<
  { id: string; status: string; prioritySet: string | null; dueDateSet: string | null; workspaceSet: string | null }[]
> {
  const response = await asUser(`http://cockpit.test/v1/items/${itemId}/rewrite-history`);
  expect(response.status).toBe(200);
  return (
    (await response.json()) as {
      entries: {
        id: string;
        status: string;
        prioritySet: string | null;
        dueDateSet: string | null;
        workspaceSet: string | null;
      }[];
    }
  ).entries;
}

/** An item's due date, whether the person made it theirs, and the time zone it was captured in, read straight out of the store. */
export async function dueDateOf(itemId: string, accountName = ACCOUNT_NAME) {
  const rows = await inStoreAsItIs(accountName, (sql) =>
    sql
      .exec<{
        due_date: string | null;
        due_date_set_at: string | null;
        due_date_chosen_at: string | null;
        captured_time_zone: string | null;
      }>(
        'SELECT due_date, due_date_set_at, due_date_chosen_at, captured_time_zone FROM items WHERE id = ? AND tenant_id = ?',
        itemId,
        accountName,
      )
      .toArray(),
  );
  return rows[0] ?? null;
}

/** The Workspace an item is in and whether anybody has said it belongs there, read straight out of the store. */
export async function workspaceOf(itemId: string) {
  const rows = await inStoreAsItIs(ACCOUNT_NAME, (sql) =>
    sql
      .exec<{ workspace_id: string; workspace_decided: number; updated_at: string }>(
        'SELECT workspace_id, workspace_decided, updated_at FROM items WHERE id = ? AND tenant_id = ?',
        itemId,
        ACCOUNT_NAME,
      )
      .toArray(),
  );
  const row = rows[0];
  return row && { workspaceId: row.workspace_id, decided: row.workspace_decided === 1, updatedAt: row.updated_at };
}

/** The ids of the items one Workspace's Inbox could draw - its snapshot, which both the Inbox and every Panel are drawn from. */
export async function itemsDrawnIn(workspaceId: string): Promise<string[]> {
  const response = await asUser(`http://cockpit.test/v1/workspaces/${workspaceId}/snapshot`);
  expect(response.status).toBe(200);
  const held = (await response.json()) as { items: { id: string }[]; filings: { itemId: string }[] };
  const filed = new Set(held.filings.map((filing) => filing.itemId));
  return held.items.filter((item) => !filed.has(item.id)).map((item) => item.id);
}

/** Waits for the reading that follows a capture to have been recorded as done, whatever it changed. */
export async function untilTheChangeIsRecorded(itemId: string): Promise<void> {
  await vi.waitFor(
    async () => {
      const [entry] = await historyOf(itemId);
      expect(entry?.status).toMatch(/^(rewritten|left-as-is)$/);
    },
    { timeout: 15_000, interval: 50 },
  );
}

/** Whether an item is filed on any Panel at all - the Inbox is the absence of one. */
export async function isFiled(itemId: string, accountName = ACCOUNT_NAME): Promise<boolean> {
  const rows = await inStoreAsItIs(accountName, (sql) =>
    sql.exec('SELECT 1 FROM panel_items WHERE item_id = ? AND tenant_id = ?', itemId, accountName).toArray(),
  );
  return rows.length > 0;
}

export async function aPanel(name: string, kind: 'items' | 'text' = 'items'): Promise<string> {
  const panelId = nextId();
  const response = await postChange('add_panel', {
    commandId: nextId(),
    issuedAt: '2026-09-09T10:00:00.000Z',
    workspaceId: WORKSPACE_ID,
    dashboardId: DASHBOARD_ID,
    panelId,
    name,
    kind,
  });
  expect(response.status).toBe(200);
  return panelId;
}

/** A second Dashboard of the Workspace, so a Panel can be made on it too. */
export async function aDashboard(): Promise<string> {
  const dashboardId = nextId();
  const response = await postChange('add_dashboard', {
    commandId: nextId(),
    issuedAt: '2026-09-09T10:00:00.000Z',
    workspaceId: WORKSPACE_ID,
    dashboardId,
    panelId: nextId(),
    name: `Dashboard ${dashboardId}`,
  });
  expect(response.status).toBe(200);
  return dashboardId;
}

/** A Panel on a named Dashboard - unlike `aPanel`, not pinned to `DASHBOARD_ID`. */
export async function aPanelOn(dashboardId: string, name: string): Promise<string> {
  const panelId = nextId();
  const response = await postChange('add_panel', {
    commandId: nextId(),
    issuedAt: '2026-09-09T10:00:00.000Z',
    workspaceId: WORKSPACE_ID,
    dashboardId,
    panelId,
    name,
    kind: 'items',
  });
  expect(response.status).toBe(200);
  return panelId;
}

export async function fileOnto(itemId: string, panelId: string): Promise<void> {
  const response = await postChange('add_item_to_panel', {
    commandId: nextId(),
    issuedAt: '2026-09-09T10:00:01.000Z',
    workspaceId: WORKSPACE_ID,
    itemId,
    panelId,
    order: [itemId],
  });
  expect(response.status).toBe(200);
}

/**
 * Settles a routing, which is what writes a decision-history entry
 * ("Learn where notes belong from where you actually file them", issue 299) -
 * unlike `fileOnto` above, which is `add_item_to_panel` and writes none.
 */
export async function moveOnto(itemId: string, panelId: string, workspaceId = WORKSPACE_ID): Promise<void> {
  const response = await postChange('move_item_to_panel', {
    commandId: nextId(),
    issuedAt: '2026-09-09T10:00:01.000Z',
    workspaceId,
    itemId,
    panelId,
    order: [itemId],
  });
  expect(response.status).toBe(200);
}

/** Keeps a Panel out of proposals, or lets it back in. */
export async function neverPropose(panelId: string, neverPropose: boolean): Promise<void> {
  const response = await postChange('set_panel_never_propose', {
    commandId: nextId(),
    issuedAt: '2026-09-09T10:00:02.000Z',
    workspaceId: WORKSPACE_ID,
    panelId,
    neverPropose,
  });
  expect(response.status).toBe(200);
}

/** One message, shaped the way the runtime hands them over. */
export function batchOf(job: EnrichmentJob) {
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

/** Registers, in the file that calls it, the setup every case here shares: a store, a key that proves nothing, and the model on the network. */
export function aModelThatReads(): void {
  beforeEach(async () => {
    await applyD1Migrations(env.DB, inject('migrations'));
    await startFromEmpty();
    await seedRegister();
    asked.length = 0;
    reading.during = null;
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
}
