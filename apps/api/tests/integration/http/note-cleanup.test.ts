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
import {
  NOTE,
  A_READING,
  SOMETHING_ELSE,
  AMBIGUOUS_NOTE,
  type Answering,
  asked,
  reading,
  theModelIs,
  postChange,
  nextId,
  captureANote,
  textsOf,
  untilTheNoteHasBeenRead,
  readAgain,
  isACleanUp,
  routingOf,
  proposalShownFor,
  priorityOf,
  historyOf,
  dueDateOf,
  workspaceOf,
  itemsDrawnIn,
  untilTheChangeIsRecorded,
  isFiled,
  aPanel,
  aDashboard,
  aPanelOn,
  fileOnto,
  moveOnto,
  neverPropose,
  aModelThatReads,
  batchOf,
} from './note-cleanup.support.js';

aModelThatReads();

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

    it('is read by Sonnet 5.5, with what it learns from sent stable-first and cached after the instructions and after the history', async () => {
      const itemId = await captureANote();

      await untilTheNoteHasBeenRead(itemId);

      const sent = asked[0]!;
      expect(sent.model).toBe('claude-sonnet-5-5');
      expect(sent.blocks).toHaveLength(3);
      expect(sent.blocks.map((block) => block.cache_control)).toEqual([{ type: 'ephemeral' }, { type: 'ephemeral' }, undefined]);
      expect(sent.blocks[0]!.text).toContain('Examples.');
      expect(sent.blocks[1]!.text).toContain('Decision history');
      expect(sent.blocks[2]!.text).toContain('Recently captured');
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
      theModelIs({ says: { ...A_READING, panel: { panelId: compliance, reason: 'a compliance question', fit: 'clear' } } });

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

    /**
     * "Propose the closest Panel at capture, and draw a less certain one
     * dashed" (issue 1107): how sure the proposal is, kept with it and read
     * back the way the Inbox reads it.
     */
    it.each([
      { situation: 'the closest match', fit: 'closest' },
      { situation: 'clear', fit: 'clear' },
    ])('keeps a proposal said to be $situation as that', async ({ fit }) => {
      const compliance = await aPanel('Compliance questions');
      theModelIs({ says: { ...A_READING, panel: { panelId: compliance, reason: 'a compliance question', fit } } });

      const itemId = await captureANote();

      await vi.waitFor(
        async () => {
          expect(await proposalShownFor(itemId)).toEqual({ proposedPanelId: compliance, proposedPanelFit: fit });
        },
        { timeout: 15_000, interval: 50 },
      );
    });

    it('proposes nothing where the model names a panel without saying how sure it is', async () => {
      const compliance = await aPanel('Compliance questions');
      // Read once naming nothing, then again by hand, so the read that names a
      // panel is the one this waits for to have finished.
      const itemId = await captureANote();
      await untilTheNoteHasBeenRead(itemId);
      theModelIs({ says: { ...A_READING, panel: { panelId: compliance, reason: 'a compliance question' } } });

      await handleQueue(batchOf({ kind: 'clean-up-a-note', accountName: ACCOUNT_NAME, itemId, attemptId: nextId() }), env);

      expect(await proposalShownFor(itemId)).toEqual({ proposedPanelId: null, proposedPanelFit: null });
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
      theModelIs({ says: { ...A_READING, panel: { panelId: foreign, reason: 'not actually offered', fit: 'clear' } } });

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
      asked.length = 0;
      theModelIs({ says: { ...A_READING, panel: { panelId: compliance, reason: 'a compliance question', fit: 'clear' } } });
      reading.during = () => fileOnto(itemId, elsewhere);

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
      theModelIs({ says: { ...A_READING, panel: { panelId: compliance, reason: 'a compliance question', fit: 'clear' } } });
      reading.during = () =>
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
      theModelIs({ says: { ...A_READING, panel: { panelId: compliance, reason: 'a compliance question', fit: 'clear' } } });
      reading.during = () =>
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
      theModelIs({ says: { ...SOMETHING_ELSE, panel: { panelId: compliance, reason: 'a compliance question', fit: 'clear' } } });

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
   * "Keep a Panel out of proposals with Never propose" (issue 848). The clean-up
   * and the re-proposal take their panels from one read, so the clean-up's
   * prompt stands for both.
   */
  describe('a panel flagged Never propose is never proposed', () => {
    it('is left out of the panels a note is offered, and offered again once cleared', async () => {
      await aPanel('Compliance questions');
      const nextUp = await aPanel('Next up');
      await neverPropose(nextUp, true);

      await readAgain();
      expect(asked[0]!.system).toContain('Compliance questions');
      expect(asked[0]!.system).not.toContain('Next up');

      await neverPropose(nextUp, false);
      await readAgain();
      expect(asked[0]!.system).toContain('Next up');
    });

    /** Flagged while the note is being read, so the panel was offered and only the write can refuse it. */
    it('discards a proposal naming it, when it was flagged while the note was being read', async () => {
      const nextUp = await aPanel('Next up');
      // The first, automatic read proposes nothing; the second, run to its end
      // here, is the one whose write meets the flag.
      const itemId = await captureANote();
      await untilTheNoteHasBeenRead(itemId);
      theModelIs({ says: { ...A_READING, panel: { panelId: nextUp, reason: 'next in line', fit: 'clear' } } });
      reading.during = () => neverPropose(nextUp, true);

      await handleQueue(batchOf({ kind: 'clean-up-a-note', accountName: ACCOUNT_NAME, itemId, attemptId: nextId() }), env);

      expect(asked).not.toHaveLength(0);
      expect((await routingOf(itemId))?.proposed_panel_id).toBeNull();
    });
  });

  describe('filings onto a panel flagged Never propose are not learned from', () => {
    it('leaves its decisions out of what a proposal reads, keeps the ordinary ones, and puts them back once cleared', async () => {
      const compliance = await aPanel('Compliance questions');
      const nextUp = await aPanel('Next up');
      const filedThere = await captureANote({ message: 'idea for the undo bar' });
      await untilTheNoteHasBeenRead(filedThere);
      await moveOnto(filedThere, nextUp);
      // Filed on an ordinary panel, and also shown on the flagged one.
      const filedBoth = await captureANote({ message: 'part 11 audit trail question' });
      await untilTheNoteHasBeenRead(filedBoth);
      await moveOnto(filedBoth, compliance);
      const alsoShown = await postChange('add_item_to_panel', {
        commandId: nextId(),
        issuedAt: '2026-09-09T10:00:01.000Z',
        workspaceId: WORKSPACE_ID,
        itemId: filedBoth,
        panelId: nextUp,
        order: [filedBoth, filedThere],
      });
      expect(alsoShown.status).toBe(200);
      await neverPropose(nextUp, true);

      await readAgain();
      expect(asked[0]!.system).not.toContain('idea for the undo bar');
      expect(asked[0]!.system).toContain('part 11 audit trail question');

      await neverPropose(nextUp, false);
      await readAgain();
      expect(asked[0]!.system).toContain('idea for the undo bar');
    });

    /** Its chip was not drawn, so filing elsewhere overrode nothing anybody saw. */
    it('records no proposal for a filing made while the panel it proposed was flagged', async () => {
      const compliance = await aPanel('Compliance questions');
      const nextUp = await aPanel('Next up');
      theModelIs({ says: { ...A_READING, panel: { panelId: nextUp, reason: 'next in line', fit: 'clear' } } });
      const first = await captureANote({ message: 'sign-off needed, who owns it' });
      await untilTheNoteHasBeenRead(first);
      // The Panel is written after the texts, so it is waited for rather than read at once.
      await vi.waitFor(async () => expect((await routingOf(first))?.proposed_panel_id).toBe(nextUp), {
        timeout: 15_000,
        interval: 20,
      });
      await neverPropose(nextUp, true);
      await moveOnto(first, compliance);
      await neverPropose(nextUp, false);
      theModelIs({ says: A_READING });

      await readAgain();
      expect(asked[0]!.system).toContain('sign-off needed, who owns it');
      expect(asked[0]!.system).not.toContain('you proposed Next up');
    });
  });

  /**
   * "Learn where notes belong from where you actually file them" (issue 299):
   * the same model call reads the account's decision history and what else
   * has been captured lately - both rendered into the system prompt, which is
   * as far as an integration test can reach into a call whose actual routing
   * is a live model's judgment call (tests/contract/clean-up-a-note.v16.test.ts
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
      theModelIs({ says: { ...A_READING, panel: { panelId: compliance, reason: 'a compliance question', fit: 'clear' } } });
      const first = await captureANote({ message: 'part 11 audit trail question' });
      await untilTheNoteHasBeenRead(first);
      await moveOnto(first, compliance);
      asked.length = 0;
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
      theModelIs({ says: { ...A_READING, panel: { panelId: compliance, reason: 'a compliance question', fit: 'clear' } } });
      const first = await captureANote({ message: 'sign-off needed, who owns it' });
      await untilTheNoteHasBeenRead(first);
      await moveOnto(first, laurens);
      asked.length = 0;
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
      theModelIs({ says: { ...A_READING, panel: { panelId: proposed, reason: 'looked like notes', fit: 'clear' } } });
      const first = await captureANote({ message: 'sign-off needed, who owns it' });
      await untilTheNoteHasBeenRead(first);
      await moveOnto(first, chosen);
      asked.length = 0;
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
      asked.length = 0;

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
      asked.length = 0;

      const itemId = await captureANote({ message: 'a second, unrelated note' });
      await untilTheNoteHasBeenRead(itemId);

      expect(asked[0]!.system).toContain('(nothing filed yet)');
      expect(asked[0]!.system).not.toContain('part 11 audit trail question');
    });

    it('names another note captured lately and not yet filed', async () => {
      const waiting = await captureANote({ message: 'still sitting in the inbox' });
      await untilTheNoteHasBeenRead(waiting);
      asked.length = 0;

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
      asked.length = 0;

      const itemId = await captureANote({ message: 'a second, unrelated note' });
      await untilTheNoteHasBeenRead(itemId);

      expect(asked[0]!.system).toContain('where does this go');
    });

    it('leaves out a note once it has been filed', async () => {
      const compliance = await aPanel('Compliance questions');
      const filed = await captureANote({ message: 'part 11 audit trail question' });
      await untilTheNoteHasBeenRead(filed);
      await moveOnto(filed, compliance);
      asked.length = 0;

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
      // Captured with a priority and a due date, so the texts are the last thing a reading could set.
      const itemId = await captureANote({ priority: 'normal', dueDate: '2026-09-30' });
      await untilTheNoteHasBeenRead(itemId);
      await postChange(name, {
        commandId: nextId(),
        issuedAt: '2026-09-09T10:00:01.000Z',
        workspaceId: WORKSPACE_ID,
        itemId,
        ...field,
      } as CommandPayload<typeof name>);
      asked.length = 0;
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

    it.each([
      { situation: 'is read again for it where the day it was captured on is known', timeZone: 'Europe/Brussels', reads: 1, expected: '2026-09-11' },
      { situation: 'is never read again for it where no day is known to count from', timeZone: undefined, reads: 0, expected: null },
    ])('with only its due date open, $situation', async ({ timeZone, reads, expected }) => {
      // The priority is chosen, so the due date is all a reading could still set.
      const itemId = await captureANote({ priority: 'normal', ...(timeZone ? { timeZone } : {}) });
      await untilTheNoteHasBeenRead(itemId);
      await postChange('set_title', {
        commandId: nextId(),
        issuedAt: '2026-09-09T10:00:01.000Z',
        workspaceId: WORKSPACE_ID,
        itemId,
        title: 'Mine',
      });
      asked.length = 0;
      theModelIs({ says: { ...SOMETHING_ELSE, dueDate: '2026-09-11' } });

      await readAgain(itemId);

      expect(asked.filter(isACleanUp)).toHaveLength(reads);
      expect((await dueDateOf(itemId))?.due_date).toBe(expected);
    });

    it('still sets the priority the note states once you have edited the title', async () => {
      const itemId = await captureANote();
      await untilTheNoteHasBeenRead(itemId);
      await postChange('set_title', {
        commandId: nextId(),
        issuedAt: '2026-09-09T10:00:01.000Z',
        workspaceId: WORKSPACE_ID,
        itemId,
        title: 'Mine',
      });
      theModelIs({ says: { ...SOMETHING_ELSE, priority: 'high' } });

      await readAgain(itemId);

      expect((await textsOf(itemId))?.title).toBe('Mine');
      expect((await priorityOf(itemId))?.priority).toBe('high');
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
      asked.length = 0;
      theModelIs({ says: SOMETHING_ELSE });
      reading.during = () =>
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
   * "Read a priority you say when you capture" (issue 1076). The model is
   * faked, so these prove what Cockpit does with the priority it is handed back,
   * not how well a note is read.
   */
  describe('a priority the note states is set on the item', () => {
    it.each([
      { situation: 'the note says it is high priority', says: 'high', expected: 'high' },
      { situation: 'the note says there is no rush', says: 'low', expected: 'low' },
      { situation: 'the note says nothing about its priority', says: undefined, expected: null },
      { situation: 'the answer names a priority Cockpit does not have', says: 'urgent', expected: null },
    ])('$situation', async ({ says, expected }) => {
      theModelIs({ says: { ...A_READING, ...(says === undefined ? {} : { priority: says }) } });

      const itemId = await captureANote();
      await untilTheChangeIsRecorded(itemId);

      expect((await priorityOf(itemId))?.priority).toBe(expected);
      // The texts beside it land whatever the priority was.
      expect((await textsOf(itemId))?.title).toBe(A_READING.title);
    });
  });

  describe('a priority you choose yourself is never replaced by the one the note states', () => {
    const setPriority = (itemId: string, priority: 'low' | 'normal' | 'high' | null, issuedAt: string) =>
      postChange('set_priority', { commandId: nextId(), issuedAt, workspaceId: WORKSPACE_ID, itemId, priority });

    it.each([
      {
        situation: 'chosen in the Capture strip',
        capturedWith: 'normal' as const,
        meanwhile: null,
        expected: 'normal',
      },
      {
        situation: 'set to Low while Cockpit is still reading the note',
        capturedWith: undefined,
        meanwhile: (itemId: string) => setPriority(itemId, 'low', '2026-09-09T10:00:01.000Z'),
        expected: 'low',
      },
      {
        situation: 'set to High and cleared again while Cockpit is still reading the note',
        capturedWith: undefined,
        meanwhile: async (itemId: string) => {
          await setPriority(itemId, 'high', '2026-09-09T10:00:01.000Z');
          await setPriority(itemId, null, '2026-09-09T10:00:02.000Z');
        },
        expected: null,
      },
    ])('keeps a priority $situation', async ({ capturedWith, meanwhile, expected }) => {
      theModelIs({ says: { ...A_READING, priority: 'high' } });
      const itemId = nextId();
      if (meanwhile) reading.during = () => meanwhile(itemId);

      await captureANote({ itemId, ...(capturedWith ? { priority: capturedWith } : {}) });
      await untilTheChangeIsRecorded(itemId);

      expect((await priorityOf(itemId))?.priority).toBe(expected);
      // And the change list says nothing about a priority it did not set.
      expect((await historyOf(itemId))[0]?.prioritySet).toBeNull();
    });

    it('takes a change you made offline, sent after the note was read', async () => {
      theModelIs({ says: { ...A_READING, priority: 'high' } });
      const itemId = await captureANote();
      await untilTheChangeIsRecorded(itemId);
      expect((await priorityOf(itemId))?.priority).toBe('high');

      // Made a second after capturing, long before Cockpit read the note, and
      // only arriving now: Cockpit's reading did not make it look stale.
      const response = await setPriority(itemId, 'low', '2026-09-09T10:00:01.000Z');

      expect(((await response.json()) as { applied: boolean }).applied).toBe(true);
      expect((await priorityOf(itemId))?.priority).toBe('low');
    });

    it('sets the priority once when the same note is read twice', async () => {
      theModelIs({ says: { ...A_READING, priority: 'high' } });
      const itemId = await captureANote();
      await untilTheChangeIsRecorded(itemId);
      const [first] = await historyOf(itemId);

      await handleQueue(batchOf({ kind: 'clean-up-a-note', accountName: ACCOUNT_NAME, itemId, attemptId: first!.id }), env);

      expect((await priorityOf(itemId))?.priority).toBe('high');
      const history = await historyOf(itemId);
      expect(history).toHaveLength(1);
      expect(history[0]!.prioritySet).toBe('high');
    });

    it('still lists the priority it set when the same note is read again after you edit the title', async () => {
      theModelIs({ says: { ...A_READING, priority: 'high' } });
      const itemId = await captureANote();
      await untilTheChangeIsRecorded(itemId);
      const [first] = await historyOf(itemId);
      await postChange('set_title', {
        commandId: nextId(),
        issuedAt: '2026-09-09T10:00:01.000Z',
        workspaceId: WORKSPACE_ID,
        itemId,
        title: 'Mine',
      });

      await handleQueue(batchOf({ kind: 'clean-up-a-note', accountName: ACCOUNT_NAME, itemId, attemptId: first!.id }), env);

      const [entry] = await historyOf(itemId);
      expect(entry?.status).toBe('rewritten');
      expect(entry?.prioritySet).toBe('high');
    });
  });

  describe('what Cockpit changed records the priority it set', () => {
    it('records the priority set on an item that had none', async () => {
      theModelIs({ says: { ...A_READING, priority: 'high' } });

      const itemId = await captureANote();
      await untilTheChangeIsRecorded(itemId);

      const [entry] = await historyOf(itemId);
      expect(entry?.status).toBe('rewritten');
      expect(entry?.prioritySet).toBe('high');
    });
  });

  /**
   * "Read a due date you say when you capture, on your own calendar" (issue
   * 1077). The model is faked, so these prove which day Cockpit tells it the
   * note was captured on and what it does with the date handed back - not how
   * well a note is read. Which calendar day an instant falls on in a zone is
   * `captureDay`'s, proved without a store (tests/unit/domain/capture-day.test.ts).
   */
  describe('a capture keeps the time zone it was made in', () => {
    it.each([
      { situation: 'a capture that carries its time zone', timeZone: 'Europe/Brussels', expected: 'Europe/Brussels' },
      { situation: 'a capture kept offline before captures carried one', timeZone: undefined, expected: null },
      { situation: 'a time zone this server does not know', timeZone: 'Mars/Olympus_Mons', expected: 'Mars/Olympus_Mons' },
    ])('$situation', async ({ timeZone, expected }) => {
      const itemId = await captureANote(timeZone === undefined ? {} : { timeZone });

      expect((await dueDateOf(itemId))?.captured_time_zone).toBe(expected);
    });

    it('refuses a capture whose time zone is not a time zone name, and keeps nothing', async () => {
      const itemId = nextId();
      const response = await postChange('capture_item', {
        commandId: nextId(),
        issuedAt: '2026-09-09T10:00:00.000Z',
        workspaceId: WORKSPACE_ID,
        itemId,
        message: NOTE,
        timeZone: 'nine hours ahead',
      });

      expect(response.status).toBe(400);
      // The store is brought up to date first: nothing before this has opened it.
      expect(await inTheStore((sql) => sql.exec('SELECT id FROM items WHERE id = ?', itemId).toArray())).toEqual([]);
    });
  });

  describe('a note is read on the calendar it was captured on', () => {
    /** The day the model was told the note `message` was captured on. */
    const toldOf = (message: string) =>
      asked.find((call) => call.note === message && isACleanUp(call))?.system.match(/Captured on: [^\n]*/u)?.[0];

    it.each([
      {
        situation: 'its own time zone, ahead of UTC across midnight',
        earlier: [],
        own: 'Pacific/Auckland',
        told: 'Captured on: Thursday 2026-09-10',
      },
      {
        situation: 'the time zone of the latest capture that had one, where it has none',
        earlier: [
          { zone: 'America/New_York', at: '2026-09-09T09:00:00.000Z' },
          { zone: 'Pacific/Auckland', at: '2026-09-09T10:00:00.000Z' },
        ],
        own: undefined,
        told: 'Captured on: Thursday 2026-09-10',
      },
      {
        situation: 'an earlier capture’s readable time zone, where its own is one this server cannot read',
        earlier: [{ zone: 'Pacific/Auckland', at: '2026-09-09T10:00:00.000Z' }],
        own: 'Mars/Olympus_Mons',
        told: 'Captured on: Thursday 2026-09-10',
      },
      {
        situation: 'no day at all, where no capture of the account ever had a time zone',
        earlier: [],
        own: undefined,
        told: 'Captured on: (not known',
      },
    ])('by $situation', async ({ earlier, own, told }) => {
      for (const [index, { zone, at }] of earlier.entries()) {
        await captureANote({ issuedAt: at, timeZone: zone, message: `earlier note ${index}` });
      }
      const message = 'send anna the q3 numbers friday';

      await captureANote({ issuedAt: '2026-09-09T13:00:00.000Z', message, ...(own ? { timeZone: own } : {}) });

      await vi.waitFor(() => expect(toldOf(message)).toBeDefined(), { timeout: 15_000, interval: 50 });
      expect(toldOf(message)).toContain(told);
    });

    it('never reads a note on the time zone of another account’s capture', async () => {
      await captureANote({ workspaceId: WORKSPACE_ID, timeZone: 'Pacific/Auckland', message: 'theirs' }, OTHER_USER_ID);
      const message = 'mine, with no time zone';

      await captureANote({ issuedAt: '2026-09-09T13:00:00.000Z', message });

      await vi.waitFor(() => expect(toldOf(message)).toBeDefined(), { timeout: 15_000, interval: 50 });
      expect(toldOf(message)).toContain('Captured on: (not known');
    });

    it('still reads the priority, and sets no due date, where it has no day to count from', async () => {
      theModelIs({ says: { ...A_READING, priority: 'high', dueDate: '2026-09-11' } });

      const itemId = await captureANote();
      await untilTheChangeIsRecorded(itemId);

      expect((await priorityOf(itemId))?.priority).toBe('high');
      expect((await dueDateOf(itemId))?.due_date).toBeNull();
    });
  });

  describe('a due date the note states is set on the item', () => {
    it.each([
      { situation: 'the note names a day', says: '2026-09-11', expected: '2026-09-11' },
      { situation: 'the note names no day', says: undefined, expected: null },
      { situation: 'the answer gives something that is not a day', says: 'Friday', expected: null },
    ])('$situation', async ({ says, expected }) => {
      theModelIs({ says: { ...A_READING, ...(says === undefined ? {} : { dueDate: says }) } });

      const itemId = await captureANote({ timeZone: 'Europe/Brussels' });
      await untilTheChangeIsRecorded(itemId);

      const stored = await dueDateOf(itemId);
      expect(stored?.due_date).toBe(expected);
      // A date Cockpit read colours along from when it was read, and is not
      // yours: you can still set or clear it, and nothing blocks you.
      expect(stored?.due_date_set_at === null).toBe(expected === null);
      expect(stored?.due_date_chosen_at).toBeNull();
      expect((await textsOf(itemId))?.title).toBe(A_READING.title);
    });
  });

  describe('a due date you choose yourself is never replaced by the one the note states', () => {
    const setDueDate = (itemId: string, dueDate: string | null, issuedAt: string) =>
      postChange('set_due_date', { commandId: nextId(), issuedAt, workspaceId: WORKSPACE_ID, itemId, dueDate });

    it.each([
      {
        situation: 'keeps a due date chosen in the Capture strip',
        capturedWith: { dueDate: '2026-09-10' },
        meanwhile: null,
        expected: '2026-09-10',
      },
      {
        situation: 'keeps a due date cleared while Cockpit is still reading the note',
        capturedWith: {},
        meanwhile: async (itemId: string) => {
          await setDueDate(itemId, '2026-09-30', '2026-09-09T10:00:01.000Z');
          await setDueDate(itemId, null, '2026-09-09T10:00:02.000Z');
        },
        expected: null,
      },
      {
        situation: 'still sets the due date where you chose only the priority',
        capturedWith: { priority: 'normal' as const },
        meanwhile: null,
        expected: '2026-09-11',
      },
    ])('$situation', async ({ capturedWith, meanwhile, expected }) => {
      theModelIs({ says: { ...A_READING, priority: 'high', dueDate: '2026-09-11' } });
      const itemId = nextId();
      if (meanwhile) reading.during = () => meanwhile(itemId);

      await captureANote({ itemId, timeZone: 'Europe/Brussels', ...capturedWith });
      await untilTheChangeIsRecorded(itemId);

      expect((await dueDateOf(itemId))?.due_date).toBe(expected);
      expect((await historyOf(itemId))[0]?.dueDateSet).toBe(expected === '2026-09-11' ? '2026-09-11' : null);
    });
  });

  describe('what Cockpit changed records the due date it set', () => {
    it('records the due date set on an item that had none, once however often the note is read', async () => {
      theModelIs({ says: { ...A_READING, dueDate: '2026-09-11' } });
      const itemId = await captureANote({ timeZone: 'Europe/Brussels' });
      await untilTheChangeIsRecorded(itemId);
      const [first] = await historyOf(itemId);

      await handleQueue(batchOf({ kind: 'clean-up-a-note', accountName: ACCOUNT_NAME, itemId, attemptId: first!.id }), env);

      const history = await historyOf(itemId);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ status: 'rewritten', dueDateSet: '2026-09-11' });
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
    it.each([
      {
        situation: 'the texts it read',
        name: 'propose_item_texts' as const,
        reading: {
          title: 'Sent by hand',
          description: 'Written by hand, and marked as Cockpit’s to overwrite.',
          readings: [],
        },
      },
      { situation: 'a priority the note stated', name: 'propose_item_fields' as const, reading: { priority: 'high' } },
      {
        situation: 'a workspace the note named',
        name: 'propose_item_fields' as const,
        reading: { settleInWorkspaceId: '018f0000-0000-7000-8000-0000000000aa' },
      },
    ])('offers no address a signed-in browser could send $situation to', async ({ name, reading }) => {
      const response = await postChange(name, {
        commandId: nextId(),
        issuedAt: '2026-09-09T10:00:00.000Z',
        workspaceId: WORKSPACE_ID,
        itemId: await captureANote(),
        ...reading,
      } as CommandPayload<typeof name>);

      expect(response.status).toBe(404);
    });
  });

  describe('a note is only ever read for the account it was captured in', () => {
    it('does nothing for an item of another account, and never reads it', async () => {
      const theirs = await captureANote(
        { workspaceId: WORKSPACE_ID },
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
      asked.length = 0;
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
            // From the clock, since only the last 30 days' corrections are read.
            issuedAt: new Date().toISOString(),
            workspaceId: WORKSPACE_ID,
            itemId: corrected,
            title: 'My own way of saying it',
          })
        ).status,
      ).toBe(200);

      asked.length = 0;
      await captureANote({ workspaceId: 'ws-atlas', itemId: nextId() });
      await vi.waitFor(() => expect(asked.length).toBeGreaterThan(0), { timeout: 15_000, interval: 50 });

      expect(asked[0]!.system).toContain('My own way of saying it');
    });

    it('never surfaces a correction made in another account', async () => {
      const theirs = await captureANote(
        { workspaceId: WORKSPACE_ID },
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

      asked.length = 0;
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
});
