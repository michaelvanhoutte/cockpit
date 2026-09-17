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
 * (tests/contract/clean-up-a-note.v8.test.ts).
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
  readings: [] as unknown[],
};

/** A second, different reading, so a case can tell "not rewritten" from "rewritten the same way". */
const SOMETHING_ELSE = {
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
const AMBIGUOUS_NOTE = {
  language: 'English',
  title: 'Call Jan',
  message: 'Call Jan.',
  readings: [{ title: 'Call in January', message: '', meaning: "'jan' is short for January" }],
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
async function untilTheNoteHasBeenRead(itemId: string): Promise<void> {
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
async function readAgain(): Promise<void> {
  asked = [];
  await captureANote({ itemId: nextId() });
  await vi.waitFor(() => expect(asked.length).toBeGreaterThan(0), { timeout: 15_000, interval: 50 });
}

/**
 * The routing Cockpit proposed for an item, read straight out of the store -
 * the panel half of "Propose where a captured note belongs, without filing it
 * there" (issue 298), beside `textsOf` above.
 */
async function routingOf(itemId: string, accountName = ACCOUNT_NAME) {
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

/** Whether an item is filed on any Panel at all - the Inbox is the absence of one. */
async function isFiled(itemId: string, accountName = ACCOUNT_NAME): Promise<boolean> {
  const rows = await inStoreAsItIs(accountName, (sql) =>
    sql.exec('SELECT 1 FROM panel_items WHERE item_id = ? AND tenant_id = ?', itemId, accountName).toArray(),
  );
  return rows.length > 0;
}

async function aPanel(name: string, kind: 'items' | 'text' = 'items'): Promise<string> {
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
async function aDashboard(): Promise<string> {
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
async function aPanelOn(dashboardId: string, name: string): Promise<string> {
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

async function fileOnto(itemId: string, panelId: string): Promise<void> {
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
async function moveOnto(itemId: string, panelId: string, workspaceId = WORKSPACE_ID): Promise<void> {
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

  /**
   * "Offer the other readings when a captured note says two things" (issue
   * 297): reporting none is the common case, proved by every fixture above
   * that reads `A_READING` and finds no readings on the row it wrote. What is
   * proved here is the rare case, and that it stops as soon as the texts are
   * somebody's own.
   */
  describe('a note that genuinely reads two ways offers the others beside the one written', () => {
    it('writes the other readings alongside the title and message it settled on', async () => {
      theModelIs({ says: AMBIGUOUS_NOTE });
      const itemId = await captureANote();

      await vi.waitFor(
        async () => {
          expect((await textsOf(itemId))?.title).toBe(AMBIGUOUS_NOTE.title);
        },
        { timeout: 15_000, interval: 50 },
      );

      const texts = await textsOf(itemId);
      expect(texts?.readings).toEqual([
        { title: 'Call in January', description: '', meaning: "'jan' is short for January" },
      ]);
    });

    it('offers nothing once you have already made the texts your own', async () => {
      const itemId = await captureANote();
      await untilTheNoteHasBeenRead(itemId);
      await postChange('set_title', {
        commandId: nextId(),
        issuedAt: '2026-09-09T10:00:01.000Z',
        workspaceId: WORKSPACE_ID,
        itemId,
        title: 'Mine',
      });
      theModelIs({ says: AMBIGUOUS_NOTE });

      await handleQueue(
        batchOf({ kind: 'clean-up-a-note', accountName: ACCOUNT_NAME, itemId, attemptId: nextId() }),
        env,
      );

      expect((await textsOf(itemId))?.readings).toBeNull();
    });
  });

  /**
   * "Propose where a captured note belongs, without filing it there" (issue
   * 298): the routing half of the same job, riding on the same model call as
   * the texts above.
   */
  describe('a note is proposed a panel, without being filed on it', () => {
    it('writes the proposal and leaves the item in the Inbox', async () => {
      const compliance = await aPanel('Compliance questions');
      theModelIs({ says: { ...A_READING, panel: { panelId: compliance, reason: 'a compliance question' } } });

      const itemId = await captureANote();
      await untilTheNoteHasBeenRead(itemId);

      await vi.waitFor(
        async () => {
          expect((await routingOf(itemId))?.proposed_panel_id).toBe(compliance);
        },
        { timeout: 15_000, interval: 50 },
      );
      expect((await routingOf(itemId))?.proposed_panel_reason).toBe('a compliance question');
      expect(await isFiled(itemId)).toBe(false);
    });

    it('proposes nothing where the model names no panel - the common, right answer', async () => {
      theModelIs({ says: A_READING });

      const itemId = await captureANote();
      await untilTheNoteHasBeenRead(itemId);

      const routing = await routingOf(itemId);
      expect(routing?.proposed_panel_id).toBeNull();
      expect(routing?.proposed_panel_reason).toBeNull();
    });

    /**
     * "Never trust a panel id back": the schema's own `enum` should already
     * make this impossible against the real model, but the fake here answers
     * whatever it is told to, which is exactly what proves the check does not
     * depend on the model behaving - `readProposal`'s own validation is what
     * catches it, before the job ever tries to write anything.
     */
    it('never proposes a panel it did not itself offer', async () => {
      const foreign = nextId();
      theModelIs({ says: { ...A_READING, panel: { panelId: foreign, reason: 'not actually offered' } } });

      const itemId = await captureANote();
      await untilTheNoteHasBeenRead(itemId);

      expect((await routingOf(itemId))?.proposed_panel_id).toBeNull();
    });

    /**
     * Settling a routing is filing it, so an item already on a Panel by the
     * time this write lands has already answered the question a proposal
     * asks - and the write refuses to disturb what is already true, the same
     * rule `command-service.ts`'s own comment states.
     */
    it('discards the proposal, and disturbs nothing, when the item was filed while the note was being read', async () => {
      const compliance = await aPanel('Compliance questions');
      const elsewhere = await aPanel('Somewhere else');
      // The first, automatic read proposes no panel - spent here so that the
      // manual second read below is the only one that ever tries to, and the
      // race is on that write and nothing else.
      const itemId = await captureANote();
      await untilTheNoteHasBeenRead(itemId);
      asked = [];
      theModelIs({ says: { ...A_READING, panel: { panelId: compliance, reason: 'a compliance question' } } });
      whileReading = () => fileOnto(itemId, elsewhere);

      await handleQueue(batchOf({ kind: 'clean-up-a-note', accountName: ACCOUNT_NAME, itemId, attemptId: nextId() }), env);

      expect((await routingOf(itemId))?.proposed_panel_id).toBeNull();
      expect(await isFiled(itemId)).toBe(true);
    });

    /**
     * The panel a routing proposal names is checked fresh, at the moment of
     * writing, against what is actually still true - not against the list the
     * prompt was built from - which is what catches one deleted in the window
     * between asking and this write landing.
     */
    it('discards the proposal when the panel it named was deleted while the note was being read', async () => {
      const compliance = await aPanel('Compliance questions');
      theModelIs({ says: { ...A_READING, panel: { panelId: compliance, reason: 'a compliance question' } } });
      whileReading = () =>
        postChange('delete_panel', {
          commandId: nextId(),
          issuedAt: '2026-09-09T10:00:01.000Z',
          workspaceId: WORKSPACE_ID,
          panelId: compliance,
        });

      const itemId = await captureANote();
      await untilTheNoteHasBeenRead(itemId);

      expect((await routingOf(itemId))?.proposed_panel_id).toBeNull();
    });

    /**
     * `delete_workspace` tombstones the Workspace alone and leaves its
     * Dashboards and Panels untouched, so a Panel of a deleted Workspace would
     * otherwise still read as live to everything but this check.
     */
    it('discards the proposal when the item’s own workspace was deleted while the note was being read', async () => {
      const compliance = await aPanel('Compliance questions');
      theModelIs({ says: { ...A_READING, panel: { panelId: compliance, reason: 'a compliance question' } } });
      whileReading = () =>
        postChange('delete_workspace', {
          commandId: nextId(),
          issuedAt: '2026-09-09T10:00:01.000Z',
          workspaceId: WORKSPACE_ID,
        });

      const itemId = await captureANote();
      await untilTheNoteHasBeenRead(itemId);

      expect((await routingOf(itemId))?.proposed_panel_id).toBeNull();
    });

    /**
     * The text cleanup this job already did has no dependency on the
     * Workspace at all (`propose_item_texts`'s own handler checks only the
     * Item) - so a Workspace gone *before* the Panels read even runs must not
     * hold that cleanup hostage to a read only the routing half needs.
     */
    it('still cleans up the note when the item’s own workspace had already been deleted', async () => {
      const compliance = await aPanel('Compliance questions');
      // The first, automatic read is spent with the workspace still live, so
      // the second - driven after the deletion - is the only one testing
      // this race.
      const itemId = await captureANote();
      await untilTheNoteHasBeenRead(itemId);
      await postChange('delete_workspace', {
        commandId: nextId(),
        issuedAt: '2026-09-09T10:00:01.000Z',
        workspaceId: WORKSPACE_ID,
      });
      theModelIs({ says: { ...SOMETHING_ELSE, panel: { panelId: compliance, reason: 'a compliance question' } } });

      await handleQueue(batchOf({ kind: 'clean-up-a-note', accountName: ACCOUNT_NAME, itemId, attemptId: nextId() }), env);

      expect((await textsOf(itemId))?.title).toBe(SOMETHING_ELSE.title);
      expect((await routingOf(itemId))?.proposed_panel_id).toBeNull();
    });

    it('offers only the panels that take items, never one made of text', async () => {
      await aPanel('Compliance questions');
      await aPanel('Reading list', 'text');
      theModelIs({ says: A_READING });

      const itemId = await captureANote();
      await untilTheNoteHasBeenRead(itemId);

      expect(asked[0]!.system).toContain('Compliance questions');
      expect(asked[0]!.system).not.toContain('Reading list');
    });
  });

  /**
   * "Learn where notes belong from where you actually file them" (issue 299):
   * the same model call reads the account's decision history and what else
   * has been captured lately - both rendered into the system prompt, which is
   * as far as an integration test can reach into a call whose actual routing
   * is a live model's judgment call (tests/contract/clean-up-a-note.v8.test.ts
   * proves the judgment itself).
   */
  describe('a proposal is asked with the account’s decision history and its recent, unfiled captures', () => {
    it('says nothing was filed yet, and nothing else is waiting, for the first note of an account', async () => {
      theModelIs({ says: A_READING });

      const itemId = await captureANote();
      await untilTheNoteHasBeenRead(itemId);

      expect(asked[0]!.system).toContain('(nothing filed yet)');
      expect(asked[0]!.system).toContain('(nothing else waiting right now)');
    });

    it('names an earlier note and where it was filed, once one has been', async () => {
      const compliance = await aPanel('Compliance questions');
      theModelIs({ says: { ...A_READING, panel: { panelId: compliance, reason: 'a compliance question' } } });
      const first = await captureANote({ message: 'part 11 audit trail question' });
      await untilTheNoteHasBeenRead(first);
      await moveOnto(first, compliance);
      asked = [];
      theModelIs({ says: A_READING });

      const second = await captureANote({ message: 'a second, unrelated note' });
      await untilTheNoteHasBeenRead(second);

      expect(asked[0]!.system).toContain('part 11 audit trail question');
      expect(asked[0]!.system).toContain('Compliance questions');
      expect(asked[0]!.system).toContain('accepted the proposal');
    });

    it('names both the wrong and the right panel, once a proposal has been overridden', async () => {
      const compliance = await aPanel('Compliance questions');
      const laurens = await aPanel('Laurens');
      theModelIs({ says: { ...A_READING, panel: { panelId: compliance, reason: 'a compliance question' } } });
      const first = await captureANote({ message: 'sign-off needed, who owns it' });
      await untilTheNoteHasBeenRead(first);
      await moveOnto(first, laurens);
      asked = [];
      theModelIs({ says: A_READING });

      const second = await captureANote({ message: 'a second, unrelated note' });
      await untilTheNoteHasBeenRead(second);

      expect(asked[0]!.system).toContain('Compliance questions');
      expect(asked[0]!.system).toContain('Laurens');
      expect(asked[0]!.system).toContain('but it was filed on Laurens instead');
    });

    /**
     * A Panel's name is unique only within its own Dashboard, never across a
     * whole Workspace, so two Panels can genuinely share a name. Comparing
     * by name rather than by id would read this override as an accept the
     * moment that happens - checked here rather than assumed.
     */
    it('still reads an override as an override when the proposed and chosen panels share a name', async () => {
      const firstDashboard = await aDashboard();
      const secondDashboard = await aDashboard();
      const proposed = await aPanelOn(firstDashboard, 'Notes');
      const chosen = await aPanelOn(secondDashboard, 'Notes');
      theModelIs({ says: { ...A_READING, panel: { panelId: proposed, reason: 'looked like notes' } } });
      const first = await captureANote({ message: 'sign-off needed, who owns it' });
      await untilTheNoteHasBeenRead(first);
      await moveOnto(first, chosen);
      asked = [];
      theModelIs({ says: A_READING });

      const second = await captureANote({ message: 'a second, unrelated note' });
      await untilTheNoteHasBeenRead(second);

      expect(asked[0]!.system).toContain('you proposed Notes, but it was filed on Notes instead');
      expect(asked[0]!.system).not.toContain('accepted the proposal');
    });

    it('never carries a decision made in another workspace', async () => {
      await alsoWorkspaces();
      const compliance = await aPanel('Compliance questions');
      const first = await captureANote({ message: 'part 11 audit trail question' });
      await untilTheNoteHasBeenRead(first);
      await moveOnto(first, compliance);
      asked = [];

      const elsewhere = await captureANote({ workspaceId: 'ws-personal', message: 'buy milk' });
      await vi.waitFor(
        async () => {
          expect((await textsOf(elsewhere, ACCOUNT_NAME))?.title).toBe(A_READING.title);
        },
        { timeout: 15_000, interval: 50 },
      );

      expect(asked[0]!.system).toContain('(nothing filed yet)');
      expect(asked[0]!.system).not.toContain('part 11 audit trail question');
    });

    /**
     * `decisionHistoryForWorkspace` joins the Item back in to read its
     * captured text, and a dismissed Item is not deleted (architecture,
     * "Tombstones, not deletes") - so without excluding it explicitly, the
     * note somebody dismissed would go on being handed to every future
     * classification call anyway.
     */
    it('never carries a decision about a note that has since been dismissed', async () => {
      const compliance = await aPanel('Compliance questions');
      const dismissed = await captureANote({ message: 'part 11 audit trail question' });
      await untilTheNoteHasBeenRead(dismissed);
      await moveOnto(dismissed, compliance);
      await postChange('set_dismissed', {
        commandId: nextId(),
        issuedAt: '2026-09-09T10:00:02.000Z',
        workspaceId: WORKSPACE_ID,
        itemId: dismissed,
        dismissed: true,
      });
      asked = [];

      const itemId = await captureANote({ message: 'a second, unrelated note' });
      await untilTheNoteHasBeenRead(itemId);

      expect(asked[0]!.system).toContain('(nothing filed yet)');
      expect(asked[0]!.system).not.toContain('part 11 audit trail question');
    });

    it('names another note captured lately and not yet filed', async () => {
      const waiting = await captureANote({ message: 'still sitting in the inbox' });
      await untilTheNoteHasBeenRead(waiting);
      asked = [];

      const itemId = await captureANote({ message: 'a second, unrelated note' });
      await untilTheNoteHasBeenRead(itemId);

      expect(asked[0]!.system).toContain('still sitting in the inbox');
      // Not the note itself - it is not "another" note to its own call, and it
      // is sent as the message being asked about, never as part of the system
      // prompt's own reading material.
      expect(asked[0]!.system).not.toContain('a second, unrelated note');
    });

    /**
     * An Item nobody has said the Workspace of yet shows in every Workspace's
     * Inbox at once ("Capture something before you know which workspace it
     * belongs to", issue 165) - so it is still "captured lately and not yet
     * filed" for a note being proposed in any of them, this one included.
     */
    it('names an undecided note as well, which waits in every workspace’s inbox', async () => {
      const waiting = await captureANote({ message: 'where does this go', workspaceDecided: false });
      await untilTheNoteHasBeenRead(waiting);
      asked = [];

      const itemId = await captureANote({ message: 'a second, unrelated note' });
      await untilTheNoteHasBeenRead(itemId);

      expect(asked[0]!.system).toContain('where does this go');
    });

    it('leaves out a note once it has been filed', async () => {
      const compliance = await aPanel('Compliance questions');
      const filed = await captureANote({ message: 'part 11 audit trail question' });
      await untilTheNoteHasBeenRead(filed);
      await moveOnto(filed, compliance);
      asked = [];

      const itemId = await captureANote({ message: 'a second, unrelated note' });
      await untilTheNoteHasBeenRead(itemId);

      // Named once, in the decision history - and not a second time in the
      // recently-captured section, since filing is what takes it out of that
      // set.
      expect(asked[0]!.system.match(/part 11 audit trail question/g)).toHaveLength(1);
    });
  });

  /**
   * "Cap the routing prompt to the last 50 decisions on panels that still
   * exist, and drop the correction override" (issue 450): the Workspace's own
   * correction (`set_routing_summary_correction`) is no longer read into this
   * call at all, whether or not one has been written - as far as an
   * integration test can reach into a call whose actual routing is a live
   * model's judgment call (tests/contract/clean-up-a-note.v8.test.ts proves
   * the judgment itself).
   */
  it('never asks with a workspace correction, even once one has been written', async () => {
    const response = await postChange('set_routing_summary_correction', {
      commandId: nextId(),
      issuedAt: '2026-09-09T09:00:00.000Z',
      workspaceId: WORKSPACE_ID,
      correction: 'Sign-off and audit-trail questions go to Laurens, not Compliance questions.',
    });
    expect(response.status).toBe(200);
    theModelIs({ says: A_READING });

    const itemId = await captureANote();
    await untilTheNoteHasBeenRead(itemId);

    expect(asked[0]!.system).not.toContain('Laurens, not Compliance questions');
    expect(asked[0]!.system).not.toContain('written a correction');
  });

  /**
   * "Cap the routing prompt to the last 50 decisions on panels that still
   * exist, and drop the correction override" (issue 450): the volume cap, the
   * Panel-existence filter and the Dashboard-existence filter it implies, all
   * read through `decisionHistoryForWorkspace` (`repo.ts`), which is what an
   * integration test can reach - the render itself is `note-cleanup.test.ts`'s
   * sibling describe above.
   *
   * Written by row rather than through `move_item_to_panel`, for the same
   * reason `alsoWorkspaces` (`seed.ts`) writes its fixtures directly: a real
   * filing would enqueue a read for every one of many decisions and race the
   * fake model against the one capture each case is actually about. What is
   * under test is the query's cap and its filters, not the write path, which
   * `decision-history.test.ts` already covers.
   */
  describe('the decision history a proposal reads is bounded by volume and by the panel still existing', () => {
    async function aSettledDecision(panelId: string, decidedAt: string, title: string): Promise<void> {
      const itemId = nextId();
      await inStoreAsItIs(ACCOUNT_NAME, (sql) => {
        sql.exec(
          `INSERT INTO items (id, tenant_id, workspace_id, source, title, status, unseen, created_at, updated_at)
           VALUES (?, ?, ?, 'internal', ?, 'to_process', 0, ?, ?)`,
          itemId,
          ACCOUNT_NAME,
          WORKSPACE_ID,
          title,
          decidedAt,
          decidedAt,
        );
        sql.exec(
          `INSERT INTO decision_history (id, tenant_id, workspace_id, item_id, chosen_panel_id, decided_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          nextId(),
          ACCOUNT_NAME,
          WORKSPACE_ID,
          itemId,
          panelId,
          decidedAt,
        );
      });
    }

    /** Strictly increasing across the range every case below uses (n <= 59). */
    function decidedAt(n: number): string {
      return `2026-09-01T00:00:${String(n).padStart(2, '0')}.000Z`;
    }

    function label(n: number): string {
      return `decision-${String(n).padStart(2, '0')}`;
    }

    /**
     * One round trip for the whole batch, the same convention `alsoWorkspaces`
     * (`seed.ts`) already uses for a multi-row fixture - `aSettledDecision`
     * above is for the ad-hoc one-or-two-row cases below, where a round trip
     * each costs nothing worth batching for.
     */
    async function settledDecisions(panelId: string, count: number, from = 1): Promise<void> {
      await inStoreAsItIs(ACCOUNT_NAME, (sql) => {
        for (let n = from; n < from + count; n += 1) {
          const itemId = nextId();
          const at = decidedAt(n);
          sql.exec(
            `INSERT INTO items (id, tenant_id, workspace_id, source, title, status, unseen, created_at, updated_at)
             VALUES (?, ?, ?, 'internal', ?, 'to_process', 0, ?, ?)`,
            itemId,
            ACCOUNT_NAME,
            WORKSPACE_ID,
            label(n),
            at,
            at,
          );
          sql.exec(
            `INSERT INTO decision_history (id, tenant_id, workspace_id, item_id, chosen_panel_id, decided_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            nextId(),
            ACCOUNT_NAME,
            WORKSPACE_ID,
            itemId,
            panelId,
            at,
          );
        }
      });
    }

    it.each([
      { situation: 'fewer than fifty qualifying decisions exist', count: 3, droppedThrough: 0 },
      { situation: 'exactly fifty qualifying decisions exist', count: 50, droppedThrough: 0 },
      { situation: 'more than fifty qualifying decisions exist', count: 55, droppedThrough: 5 },
    ])('keeps the most recent fifty and drops the rest, when $situation', async ({ count, droppedThrough }) => {
      const panel = await aPanel('Compliance questions');
      await settledDecisions(panel, count);
      theModelIs({ says: A_READING });

      const itemId = await captureANote();
      await untilTheNoteHasBeenRead(itemId);

      for (let n = 1; n <= droppedThrough; n += 1) {
        expect(asked[0]!.system).not.toContain(`"${label(n)}"`);
      }
      for (let n = droppedThrough + 1; n <= count; n += 1) {
        expect(asked[0]!.system).toContain(`"${label(n)}"`);
      }
    });

    /**
     * Two decisions can share a `decidedAt` to the millisecond - a client
     * clock's own resolution, or a replayed/near-simultaneous command - and
     * only matters once a cap makes inclusion, not merely display order,
     * depend on breaking the tie. Asserted here as deterministic, not as
     * correctly recency-ordered: `id` is the writing command's own uuidv7
     * (`decisionHistoryEntryFor`, `domain/decision-history.ts`), whose bytes
     * past the millisecond timestamp are random, so which of two
     * same-millisecond decisions this keeps is stable for a given stored
     * dataset rather than a genuine answer to which was written first.
     */
    it('breaks a tie in decidedAt the same way every time, rather than arbitrarily', async () => {
      const panel = await aPanel('Compliance questions');
      await aSettledDecision(panel, decidedAt(1), 'tied-dropped');
      await aSettledDecision(panel, decidedAt(1), 'tied-kept');
      await settledDecisions(panel, 49, 2); // decidedAt(2..50): all strictly newer, guaranteed to survive
      theModelIs({ says: A_READING });

      const itemId = await captureANote();
      await untilTheNoteHasBeenRead(itemId);

      expect(asked[0]!.system).toContain('"tied-kept"');
      expect(asked[0]!.system).not.toContain('"tied-dropped"');
    });

    it('excludes a decision outright once its panel has been deleted, however recent', async () => {
      const live = await aPanel('Laurens');
      const gone = await aPanel('Compliance questions');
      await aSettledDecision(live, decidedAt(1), 'still-live-panel');
      await aSettledDecision(gone, decidedAt(2), 'now-deleted-panel');
      const deleted = await postChange('delete_panel', {
        commandId: nextId(),
        issuedAt: '2026-09-09T10:00:03.000Z',
        workspaceId: WORKSPACE_ID,
        panelId: gone,
      });
      expect(deleted.status).toBe(200);
      theModelIs({ says: A_READING });

      const itemId = await captureANote();
      await untilTheNoteHasBeenRead(itemId);

      expect(asked[0]!.system).toContain('"still-live-panel"');
      expect(asked[0]!.system).not.toContain('"now-deleted-panel"');
    });

    /**
     * `delete_dashboard` tombstones the Dashboard alone and leaves its
     * Panels' own `deletedAt` untouched (`command-service.ts`) - so a Panel
     * whose Dashboard is gone is exactly as unreachable as a deleted Panel,
     * and the query has to check both (`repo.ts`'s own join on `dashboards`).
     */
    it('excludes a decision outright once its panel’s dashboard has been deleted, however recent', async () => {
      const secondDashboard = await aDashboard();
      const gone = await aPanelOn(secondDashboard, 'Compliance questions');
      const live = await aPanel('Laurens');
      await aSettledDecision(live, decidedAt(1), 'still-live-dashboard');
      await aSettledDecision(gone, decidedAt(2), 'now-deleted-dashboard');
      const deleted = await postChange('delete_dashboard', {
        commandId: nextId(),
        issuedAt: '2026-09-09T10:00:04.000Z',
        workspaceId: WORKSPACE_ID,
        dashboardId: secondDashboard,
      });
      expect(deleted.status).toBe(200);
      theModelIs({ says: A_READING });

      const itemId = await captureANote();
      await untilTheNoteHasBeenRead(itemId);

      expect(asked[0]!.system).toContain('"still-live-dashboard"');
      expect(asked[0]!.system).not.toContain('"now-deleted-dashboard"');
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
      await handleQueue(batchOf({ kind: 'clean-up-a-note', accountName: ACCOUNT_NAME, itemId, attemptId: nextId() }), env);

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
      handleQueue(batchOf({ kind: 'clean-up-a-note', accountName: ACCOUNT_NAME, itemId, attemptId: nextId() }), env);

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
        readings: [],
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
        batchOf({ kind: 'clean-up-a-note', accountName: ACCOUNT_NAME, itemId: theirs, attemptId: nextId() }),
        env,
      );

      expect(asked).toHaveLength(0);
      // Their note is untouched by a job naming this account: the read inside
      // the store matched no row, so there was nothing to read or write.
      expect((await textsOf(theirs, OTHER_ACCOUNT_NAME))?.title).toBe(A_READING.title);
    });

    it('does nothing for an item that is no longer there', async () => {
      await handleQueue(
        batchOf({ kind: 'clean-up-a-note', accountName: ACCOUNT_NAME, itemId: nextId(), attemptId: nextId() }),
        env,
      );

      expect(asked).toHaveLength(0);
    });
  });
});

/**
 * "Learn how you write from the titles you correct" (issue 394): what this
 * account has corrected before is read for every note it captures, whichever
 * Workspace made the correction and whichever Workspace is reading it now -
 * unlike the routing history above, which is read one Workspace at a time.
 */
describe('Triage', () => {
  describe('a note is read against every correction this account has made in the last 30 days, in any workspace', () => {
    it('reaches a note captured in a different workspace', async () => {
      await alsoWorkspaces();
      const corrected = await captureANote();
      await untilTheNoteHasBeenRead(corrected);
      expect(
        (
          await postChange('set_title', {
            commandId: nextId(),
            issuedAt: '2026-09-09T10:00:02.000Z',
            workspaceId: WORKSPACE_ID,
            itemId: corrected,
            title: 'My own way of saying it',
          })
        ).status,
      ).toBe(200);

      asked = [];
      await captureANote({ workspaceId: 'ws-atlas', itemId: nextId() });
      await vi.waitFor(() => expect(asked.length).toBeGreaterThan(0), { timeout: 15_000, interval: 50 });

      expect(asked[0]!.system).toContain('My own way of saying it');
    });

    it('never surfaces a correction made in another account', async () => {
      const theirs = await captureANote(
        { workspaceId: WORKSPACE_ID, typeId: taskTypeIn(OTHER_ACCOUNT_NAME) },
        OTHER_USER_ID,
      );
      await vi.waitFor(
        async () => {
          expect((await textsOf(theirs, OTHER_ACCOUNT_NAME))?.title).toBe(A_READING.title);
        },
        { timeout: 15_000, interval: 50 },
      );
      expect(
        (
          await postChange(
            'set_title',
            {
              commandId: nextId(),
              issuedAt: '2026-09-09T10:00:02.000Z',
              workspaceId: WORKSPACE_ID,
              itemId: theirs,
              title: 'Their own way of saying it',
            },
            OTHER_USER_ID,
          )
        ).status,
      ).toBe(200);

      asked = [];
      await captureANote();
      await vi.waitFor(() => expect(asked.length).toBeGreaterThan(0), { timeout: 15_000, interval: 50 });

      expect(asked[0]!.system).not.toContain('Their own way of saying it');
    });

    it('says nothing, rather than a placeholder, for an account with no corrections yet', async () => {
      const itemId = await captureANote();

      await untilTheNoteHasBeenRead(itemId);

      expect(asked[0]!.system).not.toContain('Corrections');
    });

    /**
     * Whether a proposal counts as having "stood" turns on whether it has
     * actually been acted on - filed, dismissed or completed - not on
     * whether it merely exists ("Learn how you write from the titles you
     * correct", issue 394; `docs/text-learning.md`, "The rules"). Three filed
     * ones, not one, so the count clears the floor of 3 below which "what
     * stood" is omitted entirely ("Cap the text-learning prompt to the last
     * 30 days, and drop rules and pinned examples as inputs", issue 451).
     */
    it('counts a filed proposal as having stood, and a still-unfiled one in neither direction', async () => {
      for (let i = 0; i < 3; i += 1) {
        const filedId = await captureANote({ itemId: nextId() });
        await untilTheNoteHasBeenRead(filedId);
        const panelId = await aPanel(`Somewhere ${i}`);
        await moveOnto(filedId, panelId);
      }

      const untouchedId = await captureANote({ itemId: nextId() });
      await untilTheNoteHasBeenRead(untouchedId);

      await readAgain();

      // The three filed ones counted and none was corrected; the still-unfiled
      // one would have shown up in this ratio too had it counted.
      expect(asked[0]!.system).toContain('0 of 3 proposed texts were corrected');
    });
  });

  /**
   * "Cap the text-learning prompt to the last 30 days, and drop rules and
   * pinned examples as inputs" (issue 451): both evidence sections read
   * through `store.ts`'s `textLearningContext`, which is what an integration
   * test can reach - the render itself is `note-cleanup.test.ts`'s sibling
   * describes above, and the floor-of-3 arithmetic is `deriveWhatStoodForPrompt`'s
   * own unit tests (tests/unit/domain/text-corrections.test.ts).
   *
   * Written by row rather than through a real correction or a real
   * enrichment pass, for the same reason `aSettledDecision` (this file's
   * sibling describe below) writes by row: what is under test is the query's
   * window, not the write path, which is covered elsewhere.
   */
  describe('the corrections and what stood a proposal reads are bounded to the last 30 days', () => {
    const NOW = Date.now();
    /** Strictly inside the 30-day window at `n` days old, strictly outside it past 30. */
    function daysAgo(n: number): string {
      return new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();
    }

    async function aCorrection(recordedAt: string, capturedMessage: string, settledTitle: string): Promise<void> {
      const itemId = nextId();
      await inTheStore((sql) => {
        sql.exec(
          `INSERT INTO items (id, tenant_id, workspace_id, source, title, status, unseen, created_at, updated_at)
           VALUES (?, ?, ?, 'internal', ?, 'to_process', 0, ?, ?)`,
          itemId,
          ACCOUNT_NAME,
          WORKSPACE_ID,
          settledTitle,
          recordedAt,
          recordedAt,
        );
        sql.exec(
          `INSERT INTO text_corrections
             (item_id, tenant_id, captured_message, proposed_title, settled_title, recorded_at, updated_at)
           VALUES (?, ?, ?, 'Proposed', ?, ?, ?)`,
          itemId,
          ACCOUNT_NAME,
          capturedMessage,
          settledTitle,
          recordedAt,
          recordedAt,
        );
      });
    }

    /** A judgeable, acted-on Item whose texts stood - `completed_at` is what makes it `actedOn`. */
    async function aStoodItem(textsProposedAt: string, title: string): Promise<void> {
      const itemId = nextId();
      await inTheStore((sql) => {
        sql.exec(
          `INSERT INTO items
             (id, tenant_id, workspace_id, source, title, status, unseen, texts_proposed_at, completed_at,
              created_at, updated_at)
           VALUES (?, ?, ?, 'internal', ?, 'to_process', 0, ?, ?, ?, ?)`,
          itemId,
          ACCOUNT_NAME,
          WORKSPACE_ID,
          title,
          textsProposedAt,
          textsProposedAt,
          textsProposedAt,
          textsProposedAt,
        );
      });
    }

    /**
     * An Item Cockpit proposed for outside the window, corrected inside it -
     * the case a review of this issue found: windowing `promptCorrections`
     * and `promptStood` on two different fields let such an Item show up
     * under "Corrections" while the ratio directly beneath it read "0 of N
     * proposed texts were corrected", disagreeing with the correction the
     * prompt had just shown.
     */
    async function aStaleProposalCorrectedRecently(
      textsProposedAt: string,
      recordedAt: string,
      settledTitle: string,
    ): Promise<void> {
      const itemId = nextId();
      await inTheStore((sql) => {
        sql.exec(
          `INSERT INTO items
             (id, tenant_id, workspace_id, source, title, status, unseen, texts_proposed_at, created_at, updated_at)
           VALUES (?, ?, ?, 'internal', ?, 'to_process', 0, ?, ?, ?)`,
          itemId,
          ACCOUNT_NAME,
          WORKSPACE_ID,
          settledTitle,
          textsProposedAt,
          textsProposedAt,
          recordedAt,
        );
        sql.exec(
          `INSERT INTO text_corrections
             (item_id, tenant_id, captured_message, proposed_title, settled_title, recorded_at, updated_at)
           VALUES (?, ?, 'a stale note', 'Proposed', ?, ?, ?)`,
          itemId,
          ACCOUNT_NAME,
          settledTitle,
          recordedAt,
          recordedAt,
        );
      });
    }

    it('includes a correction from inside the window, with no minimum count needed', async () => {
      await aCorrection(daysAgo(29), 'a recent note', 'Correction from inside the window');
      await readAgain();

      expect(asked[0]!.system).toContain('Correction from inside the window');
    });

    it('excludes a correction from outside the window', async () => {
      await aCorrection(daysAgo(31), 'an old note', 'Correction from outside the window');
      await readAgain();

      expect(asked[0]!.system).not.toContain('Correction from outside the window');
    });

    /**
     * The floor-of-3 arithmetic itself, for every count either side of it, is
     * unit-tested directly against `deriveWhatStoodForPrompt`
     * (tests/unit/domain/text-corrections.test.ts) - this is the one case
     * that level cannot reach: that a real capture, through the real store
     * and a real cutoff, ends up with "What stood" in the prompt it actually
     * sends.
     */
    it('includes what stood once 3 have stood in the window', async () => {
      await aStoodItem(daysAgo(5), 'stood-one');
      await aStoodItem(daysAgo(5), 'stood-two');
      await aStoodItem(daysAgo(5), 'stood-three');
      await readAgain();

      expect(asked[0]!.system).toContain('What stood');
      expect(asked[0]!.system).toContain('0 of 3 proposed texts were corrected');
    });

    it('never counts an unchanged title from outside the window, even toward the floor', async () => {
      await aStoodItem(daysAgo(5), 'stood-one');
      await aStoodItem(daysAgo(5), 'stood-two');
      await aStoodItem(daysAgo(31), 'stood-outside-the-window');
      await readAgain();

      // Only the two in-window Items count, one short of the floor of 3.
      expect(asked[0]!.system).not.toContain('What stood');
    });

    it('counts a text proposed outside the window but corrected inside it toward what stood, not neither total', async () => {
      await aStoodItem(daysAgo(5), 'stood-one');
      await aStoodItem(daysAgo(5), 'stood-two');
      await aStoodItem(daysAgo(5), 'stood-three');
      await aStaleProposalCorrectedRecently(daysAgo(60), daysAgo(5), 'Corrected long after being proposed');
      await readAgain();

      expect(asked[0]!.system).toContain('Corrected long after being proposed');
      // Four in-window Items now: three stood, one corrected - never "0 of 3".
      expect(asked[0]!.system).toContain('1 of 4 proposed texts were corrected');
    });
  });

  /**
   * "Cap the text-learning prompt to the last 30 days, and drop rules and
   * pinned examples as inputs" (issue 451): both are still stored and still
   * shown on the window that reads and writes them - only the prompt itself
   * stopped reading either.
   */
  describe('the prompt no longer reads this account’s own rules or pinned examples', () => {
    it('is built without a rule the account has written', async () => {
      const response = await postChange('set_text_learning_rules', {
        commandId: nextId(),
        issuedAt: '2026-09-09T09:00:00.000Z',
        workspaceId: ACCOUNT_WIDE,
        rules: 'Never end a title with a question mark.',
      });
      expect(response.status).toBe(200);

      const itemId = await captureANote();
      await untilTheNoteHasBeenRead(itemId);

      expect(asked[0]!.system).not.toContain('Never end a title with a question mark.');
    });

    it('is built without an example the account has pinned', async () => {
      const response = await postChange('pin_text_example', {
        commandId: nextId(),
        issuedAt: '2026-09-09T09:00:00.000Z',
        workspaceId: ACCOUNT_WIDE,
        exampleId: nextId(),
        note: 'bel novy ivm afspraak',
        title: 'A pinned title nothing else in this test writes',
        description: '',
      });
      expect(response.status).toBe(200);

      const itemId = await captureANote();
      await untilTheNoteHasBeenRead(itemId);

      expect(asked[0]!.system).not.toContain('A pinned title nothing else in this test writes');
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
