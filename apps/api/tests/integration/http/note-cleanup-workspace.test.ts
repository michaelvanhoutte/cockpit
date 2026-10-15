import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { ACCOUNT_WIDE, FIRST_WORKSPACE_NAME } from '@cockpit/shared';
import { ACCOUNT_NAME, WORKSPACE_ID, alsoWorkspaces, asUser, inStoreAsItIs, inTheStore, storeNamed } from '../seed.js';
import { handleQueue } from '../../../src/jobs/index.js';
import {
  A_READING,
  asked,
  reading,
  theModelIs,
  theModelReadsAPlace,
  postChange,
  nextId,
  captureANote,
  isACleanUp,
  isAPanelChoice,
  routingOf,
  historyOf,
  workspaceOf,
  itemsDrawnIn,
  untilTheChangeIsRecorded,
  isFiled,
  aPanel,
  moveOnto,
  aModelThatReads,
  batchOf,
  duringThe,
} from './note-cleanup.support.js';

aModelThatReads();

describe('Capture', () => {
  /**
   * "Settle an Any workspace capture in the workspace you name" (issue 1078),
   * read since "File a capture on the panels you name, read from the spoken
   * path" (issue 1116) from the names the place words mean. The model is
   * faked, so these prove what Cockpit does with the workspace it is handed
   * back - against a real store, since settling is a command and the Inbox is
   * a query over where an item belongs.
   */
  describe('a workspace the note names settles an item captured to Any workspace, and only that', () => {
    beforeEach(async () => {
      await alsoWorkspaces();
    });

    const filedBeforeItLands = async (itemId: string) => {
      const panelId = await aPanel('Compliance questions');
      await moveOnto(itemId, panelId);
    };
    const deletedWhileReading = async () => {
      await postChange('delete_workspace', {
        commandId: nextId(),
        issuedAt: '2026-09-09T10:00:01.000Z',
        workspaceId: 'ws-personal',
      });
    };

    it.each([
      {
        situation: 'the note names Personal, in other letters, for an item captured to Any workspace',
        capturedWith: { workspaceDecided: false },
        names: 'personal',
        meanwhile: null,
        expected: { workspaceId: 'ws-personal', decided: true },
      },
      {
        situation: 'the note names Personal for an item captured inside a workspace',
        capturedWith: {},
        names: 'Personal',
        meanwhile: null,
        expected: { workspaceId: WORKSPACE_ID, decided: true },
      },
      {
        situation: 'you filed the item in the first workspace before the reading landed',
        capturedWith: { workspaceDecided: false },
        names: 'Personal',
        meanwhile: filedBeforeItLands,
        expected: { workspaceId: WORKSPACE_ID, decided: true },
      },
      {
        situation: 'the note names a workspace deleted after the model was shown its name',
        capturedWith: { workspaceDecided: false },
        names: 'Personal',
        meanwhile: deletedWhileReading,
        expected: { workspaceId: WORKSPACE_ID, decided: false },
      },
      {
        situation: 'the note names a workspace the account does not have',
        capturedWith: { workspaceDecided: false },
        names: 'Nowhere',
        meanwhile: null,
        expected: { workspaceId: WORKSPACE_ID, decided: false },
      },
      {
        situation: 'the note names no workspace',
        capturedWith: { workspaceDecided: false },
        names: undefined,
        meanwhile: null,
        expected: { workspaceId: WORKSPACE_ID, decided: false },
      },
    ])('leaves an item where it belongs when $situation', async ({ capturedWith, names, meanwhile, expected }) => {
      theModelReadsAPlace(names === undefined ? null : { workspace: names });
      const itemId = nextId();
      if (meanwhile) reading.during = duringThe(isACleanUp, () => meanwhile(itemId));

      await captureANote({ itemId, ...capturedWith });
      await untilTheChangeIsRecorded(itemId);

      expect(await workspaceOf(itemId)).toMatchObject(expected);
      // Nothing is ever made for a name that matches nothing.
      const held = await inStoreAsItIs(ACCOUNT_NAME, (sql) => sql.exec('SELECT 1 FROM workspaces').toArray());
      expect(held).toHaveLength(3);
    });

    it('leaves the time it last changed where it was, so an edit of yours made offline still applies', async () => {
      theModelReadsAPlace({ workspace: 'Personal' });
      const itemId = await captureANote({ workspaceDecided: false });
      await untilTheChangeIsRecorded(itemId);

      expect(await workspaceOf(itemId)).toMatchObject({
        workspaceId: 'ws-personal',
        updatedAt: '2026-09-09T10:00:00.000Z',
      });
    });

    it('moves the item out of every other workspace’s Inbox, and tells every open tab', async () => {
      // The first read names nothing, so the item waits in every Inbox.
      theModelReadsAPlace(null);
      const itemId = await captureANote({ workspaceDecided: false });
      await untilTheChangeIsRecorded(itemId);
      for (const workspaceId of [WORKSPACE_ID, 'ws-atlas', 'ws-personal']) {
        expect(await itemsDrawnIn(workspaceId)).toContain(itemId);
      }
      const tabsCopy = await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/snapshot`);
      const from = ((await tabsCopy.json()) as { upTo: string }).upTo;

      theModelReadsAPlace({ workspace: 'Personal' });
      await handleQueue(batchOf({ kind: 'clean-up-a-note', accountName: ACCOUNT_NAME, itemId, attemptId: nextId() }), env);

      expect(await itemsDrawnIn('ws-personal')).toContain(itemId);
      expect(await itemsDrawnIn(WORKSPACE_ID)).not.toContain(itemId);
      expect(await itemsDrawnIn('ws-atlas')).not.toContain(itemId);
      // A tab on any workspace is told, whichever it is showing.
      const answer = await storeNamed(ACCOUNT_NAME).changesSince(ACCOUNT_NAME, from);
      expect(answer).toMatchObject({ status: 'ok' });
      expect((answer as { value: { events: { type: string; workspaceId: string }[] } }).value.events).toContainEqual(
        expect.objectContaining({ type: 'snapshot_invalidated', workspaceId: ACCOUNT_WIDE }),
      );
    });
  });

  describe('the panel proposed follows the workspace the note settled the item in', () => {
    let workPanel: string;
    const PERSONAL_PANEL = 'ws-personal-panel-1';
    /** The calls one capture makes: the clean-up, which names the first workspace's Panel, the read of the place, and the Panel choice. */
    const theModelNames = (workspace: string | undefined, choosing: unknown) =>
      theModelReadsAPlace(workspace === undefined ? null : { workspace }, {
        cleanUp: { panel: { panelId: workPanel, reason: 'a compliance question', fit: 'clear' } },
        choosing,
      });

    beforeEach(async () => {
      await alsoWorkspaces();
      workPanel = await aPanel('Compliance questions');
    });

    it('proposes a panel of the new workspace in place of the one among the old workspace’s, with one more call', async () => {
      theModelNames('Personal', { panelId: PERSONAL_PANEL, reason: 'an errand' });

      const itemId = await captureANote({ workspaceDecided: false });
      await untilTheChangeIsRecorded(itemId);

      await vi.waitFor(async () => expect((await routingOf(itemId))?.proposed_panel_id).toBe(PERSONAL_PANEL), {
        timeout: 15_000,
        interval: 50,
      });
      expect((await routingOf(itemId))?.proposed_panel_reason).toBe('an errand');
      expect(asked.filter(isACleanUp)).toHaveLength(1);
      expect(asked.filter(isAPanelChoice)).toHaveLength(1);
      // It is offered the new workspace's panels only.
      expect(asked.find(isAPanelChoice)!.system).toContain(PERSONAL_PANEL);
      expect(asked.find(isAPanelChoice)!.system).not.toContain(workPanel);
      expect(await isFiled(itemId)).toBe(false);
    });

    it('withdraws a panel already proposed among the old workspace’s when the new one has none that fits', async () => {
      // A first read that names no workspace leaves the first workspace's panel proposed.
      theModelNames(undefined, null);
      const itemId = await captureANote({ workspaceDecided: false });
      await vi.waitFor(async () => expect((await routingOf(itemId))?.proposed_panel_id).toBe(workPanel), {
        timeout: 15_000,
        interval: 50,
      });

      theModelNames('Personal', { panelId: '', reason: '' });
      await handleQueue(batchOf({ kind: 'clean-up-a-note', accountName: ACCOUNT_NAME, itemId, attemptId: nextId() }), env);

      expect(await workspaceOf(itemId)).toMatchObject({ workspaceId: 'ws-personal', decided: true });
      expect((await routingOf(itemId))?.proposed_panel_id).toBeNull();
    });

    it('proposes nothing, and asks for no panel, where the new workspace has no panel that takes items', async () => {
      // Its one panel is made a text panel, which takes no items.
      await inTheStore((sql) => sql.exec("UPDATE panels SET kind = 'text' WHERE id = ?", PERSONAL_PANEL));
      theModelNames('Personal', { panelId: PERSONAL_PANEL, reason: 'would be refused' });

      const itemId = await captureANote({ workspaceDecided: false });
      await untilTheChangeIsRecorded(itemId);

      expect(await workspaceOf(itemId)).toMatchObject({ workspaceId: 'ws-personal', decided: true });
      expect((await routingOf(itemId))?.proposed_panel_id).toBeNull();
      expect(asked.filter(isAPanelChoice)).toHaveLength(0);
    });

    it('makes one call only, and keeps the panel it proposed, where the note names no place', async () => {
      theModelNames(undefined, { panelId: PERSONAL_PANEL, reason: 'never asked' });

      const itemId = await captureANote({ workspaceDecided: false });
      await untilTheChangeIsRecorded(itemId);
      await vi.waitFor(async () => expect((await routingOf(itemId))?.proposed_panel_id).toBe(workPanel), {
        timeout: 15_000,
        interval: 50,
      });

      expect(asked).toHaveLength(1);
    });

    it('asks for no panel, and keeps the panel it proposed, where the note names the workspace the item already sits in', async () => {
      theModelNames(FIRST_WORKSPACE_NAME, { panelId: PERSONAL_PANEL, reason: 'never asked' });

      const itemId = await captureANote({ workspaceDecided: false });
      await untilTheChangeIsRecorded(itemId);
      await vi.waitFor(async () => expect((await routingOf(itemId))?.proposed_panel_id).toBe(workPanel), {
        timeout: 15_000,
        interval: 50,
      });

      expect(await workspaceOf(itemId)).toMatchObject({ workspaceId: WORKSPACE_ID, decided: true });
      expect(asked.filter(isAPanelChoice)).toHaveLength(0);
    });

    it('proposes no panel, and still records the move, where the panel choice fails', async () => {
      theModelIs({
        by: (call) => {
          if (isAPanelChoice(call)) throw new Error('the model could not be reached');
          if (isACleanUp(call)) {
            return { ...A_READING, place: 'for personal', panel: { panelId: workPanel, reason: 'a compliance question', fit: 'clear' } };
          }
          return { workspace: 'Personal', dashboard: '', panels: [] };
        },
      });

      const itemId = await captureANote({ workspaceDecided: false });
      await untilTheChangeIsRecorded(itemId);

      expect(await workspaceOf(itemId)).toMatchObject({ workspaceId: 'ws-personal', decided: true });
      expect((await routingOf(itemId))?.proposed_panel_id).toBeNull();
      expect((await historyOf(itemId))[0]).toMatchObject({ status: 'rewritten', workspaceSet: 'Personal' });
    });
  });

  describe('what Cockpit changed records the workspace it settled the item in', () => {
    beforeEach(async () => {
      await alsoWorkspaces();
    });

    it('records the workspace by name, once however often the note is read', async () => {
      theModelReadsAPlace({ workspace: 'personal' });
      const itemId = await captureANote({ workspaceDecided: false });
      await untilTheChangeIsRecorded(itemId);
      const [first] = await historyOf(itemId);

      await handleQueue(batchOf({ kind: 'clean-up-a-note', accountName: ACCOUNT_NAME, itemId, attemptId: first!.id }), env);

      const history = await historyOf(itemId);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ status: 'rewritten', workspaceSet: 'Personal' });
    });

    it('records none where it settled none', async () => {
      theModelReadsAPlace(null);
      const itemId = await captureANote({ workspaceDecided: false });
      await untilTheChangeIsRecorded(itemId);

      expect((await historyOf(itemId))[0]?.workspaceSet).toBeNull();
    });
  });
});
