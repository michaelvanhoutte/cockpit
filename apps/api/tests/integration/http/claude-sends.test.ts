import { beforeEach, describe, expect, inject, it } from 'vitest';
import { SELF, applyD1Migrations, env } from 'cloudflare:test';
import type { AgentRun, CommandName, CommandPayload, WorkspaceSnapshot } from '@cockpit/shared';
import {
  DASHBOARD_ID,
  OTHER_USER_ID,
  USER_ID,
  WORKSPACE_ID,
  alsoWorkspaces,
  asUser,
  inTheStore,
  seedRegister,
  signInAs,
  startFromEmpty,
} from '../seed.js';

/**
 * Integration level, through the real Worker: what sending an Item to Cowork
 * or Claude Code records, what it refuses, and how the Item's Status ends it
 * ("Send an item to Cowork or Claude Code with its prompt reviewed first",
 * issue 1159) - all of which is the store and the route together.
 *
 * Not re-proved here: the address and the prompt, which are
 * packages/shared/tests/unit/domain/claude-send.test.ts's; the chip's wording,
 * which is the web app's own F1 test; and how an Agent's run is started or
 * settled, which is agent-runs.test.ts's.
 */

const ATLAS = 'ws-atlas';
const AT = '2026-10-16T10:00:00.000Z';
const later = (seconds: number) => new Date(Date.parse(AT) + seconds * 1000).toISOString();

let seq = 0;
const nextId = () => {
  seq += 1;
  return `018f0000-0000-7000-9000-${String(seq).padStart(12, '0')}`;
};

async function postChange<N extends CommandName>(
  name: N,
  payload: Omit<CommandPayload<N>, 'commandId' | 'issuedAt'> & { commandId?: string },
  userId = USER_ID,
  issuedAt = AT,
) {
  return asUser(
    `http://cockpit.test/v1/commands/${name}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: nextId(), issuedAt, ...payload }),
    },
    userId,
  );
}

async function snapshot(workspaceId = WORKSPACE_ID): Promise<WorkspaceSnapshot> {
  const res = await asUser(`http://cockpit.test/v1/workspaces/${workspaceId}/snapshot`);
  expect(res.status).toBe(200);
  return (await res.json()) as WorkspaceSnapshot;
}

async function runsOn(itemId: string, workspaceId = WORKSPACE_ID): Promise<AgentRun[]> {
  return (await snapshot(workspaceId)).agentRuns.filter((run) => run.itemId === itemId);
}

async function anItem(message: string, workspaceId = WORKSPACE_ID): Promise<string> {
  const itemId = nextId();
  expect((await postChange('capture_item', { workspaceId, itemId, message })).status).toBe(200);
  return itemId;
}

async function aPanelIn(workspaceId: string): Promise<string> {
  const panelId = nextId();
  const dashboardId = workspaceId === WORKSPACE_ID ? DASHBOARD_ID : `${workspaceId}-dashboard-1`;
  expect(
    (await postChange('add_panel', { workspaceId, dashboardId, panelId, name: `Now ${seq}`, kind: 'items' })).status,
  ).toBe(200);
  return panelId;
}

function send(
  itemId: string,
  options: {
    commandId?: string;
    runId?: string;
    destination?: 'cowork' | 'code';
    folder?: string;
    workspaceId?: string;
    issuedAt?: string;
  } = {},
) {
  return postChange(
    'send_item_to_claude',
    {
      ...(options.commandId ? { commandId: options.commandId } : {}),
      workspaceId: options.workspaceId ?? WORKSPACE_ID,
      itemId,
      runId: options.runId ?? nextId(),
      destination: options.destination ?? 'cowork',
      folder: options.folder ?? '',
    },
    USER_ID,
    options.issuedAt ?? AT,
  );
}

async function allRuns(itemId: string) {
  return inTheStore((sql) => [
    ...sql.exec<{ id: string; status: string; stage: string | null; ended_at: string | null }>(
      'SELECT id, status, stage, ended_at FROM agent_runs WHERE item_id = ? ORDER BY started_at, id',
      itemId,
    ),
  ]);
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  await alsoWorkspaces();
  await signInAs(USER_ID);
  await signInAs(OTHER_USER_ID);
});

describe('Agents', () => {
  describe('sending an item to Claude records one Run, Sent, on it', () => {
    it.each([
      { situation: 'Cowork with a folder', destination: 'cowork' as const, folder: 'C:\\GitHub\\Cockpit' },
      { situation: 'Code with a folder', destination: 'code' as const, folder: '/home/me/app' },
      { situation: 'Cowork with no folder', destination: 'cowork' as const, folder: '' },
    ])('records $situation, naming no Agent', async ({ destination, folder }) => {
      const itemId = await anItem('Chase the invoice');

      const res = await send(itemId, { destination, folder });

      expect(res.status).toBe(200);
      expect(await runsOn(itemId)).toEqual([
        expect.objectContaining({
          itemId,
          agentName: null,
          destination,
          folder: folder === '' ? null : folder,
          stage: 'sent',
          resultUrl: null,
          sessionUrl: null,
        }),
      ]);
    });

    it('records the same Open sent twice as one Run', async () => {
      const itemId = await anItem('Chase the invoice');
      const commandId = nextId();
      const runId = nextId();

      const first = await send(itemId, { commandId, runId });
      const again = await send(itemId, { commandId, runId });

      expect(await first.json()).toMatchObject({ applied: true });
      expect(await again.json()).toMatchObject({ applied: false });
      expect(await allRuns(itemId)).toHaveLength(1);
    });

    it('is sent from the Inbox as it is from a dashboard', async () => {
      // Captured and never filed: it is in the Inbox.
      const itemId = await anItem('Unfiled thought');

      expect((await send(itemId)).status).toBe(200);
      expect(await runsOn(itemId)).toHaveLength(1);
    });

    it.each([
      {
        situation: 'a Run already going',
        arrange: async (itemId: string) => void (await send(itemId)),
        refusal: 'Claude is already on this item.',
      },
      {
        situation: 'a done item',
        arrange: async (itemId: string) =>
          void (await postChange('set_done', { workspaceId: WORKSPACE_ID, itemId, done: true })),
        refusal: 'Claude only takes an item still to be done.',
      },
      {
        situation: 'a dismissed item',
        arrange: async (itemId: string) =>
          void (await postChange('set_dismissed', { workspaceId: WORKSPACE_ID, itemId, dismissed: true })),
        refusal: 'Claude only takes an item still to be done.',
      },
    ])('refuses $situation, in words, and writes no second Run', async ({ arrange, refusal }) => {
      const itemId = await anItem('Chase the invoice');
      await arrange(itemId);
      const before = await allRuns(itemId);

      const res = await send(itemId, { issuedAt: later(1) });

      expect({ status: res.status, said: await res.json() }).toEqual({ status: 409, said: { error: refusal } });
      expect(await allRuns(itemId)).toEqual(before);
    });

    it('answers not found for another workspace’s item, and writes nothing', async () => {
      const inAtlas = await anItem('In Atlas', ATLAS);
      // Filed on one of Atlas's panels, so it belongs there and is no one else's to send.
      await postChange('move_item_to_panel', {
        workspaceId: ATLAS,
        itemId: inAtlas,
        panelId: await aPanelIn(ATLAS),
        order: [inAtlas],
      });

      const res = await send(inAtlas, { workspaceId: WORKSPACE_ID });

      expect(res.status).toBe(404);
      expect(await allRuns(inAtlas)).toEqual([]);
    });
  });

  describe('the item’s Status ends a Run it was sent with', () => {
    it.each([
      { situation: 'Done', name: 'set_done' as const, payload: { done: true } },
      { situation: 'Dismiss', name: 'set_dismissed' as const, payload: { dismissed: true } },
      { situation: 'To do', name: 'set_started' as const, payload: { started: false } },
    ])('$situation ends it', async ({ name, payload }) => {
      const itemId = await anItem('Chase the invoice');
      await send(itemId);

      await postChange(name, { workspaceId: WORKSPACE_ID, itemId, ...payload } as never, USER_ID, later(1));

      expect((await allRuns(itemId)).map((run) => run.ended_at)).toEqual([later(1)]);
      expect(await runsOn(itemId)).toEqual([]);
    });

    it('brings the Run back when the Done is undone', async () => {
      const itemId = await anItem('Chase the invoice');
      await send(itemId);
      const [run] = await allRuns(itemId);
      await postChange('set_done', { workspaceId: WORKSPACE_ID, itemId, done: true }, USER_ID, later(1));

      await postChange(
        'set_done',
        { workspaceId: WORKSPACE_ID, itemId, done: false, reopensRunId: run!.id },
        USER_ID,
        later(2),
      );

      expect(await runsOn(itemId)).toEqual([
        expect.objectContaining({ id: run!.id, destination: 'cowork', stage: 'sent' }),
      ]);
    });
  });

  describe('the files of an item are linked for a Claude session that cannot sign in', () => {
    it('makes one address per file that opens it without signing in', async () => {
      const itemId = await anItem('Fix the layout');
      const attachmentId = nextId();
      const bytes = new Uint8Array([137, 80, 78, 71, 9]);
      const uploaded = await asUser(`http://cockpit.test/v1/items/${itemId}/attachments`, {
        method: 'POST',
        headers: {
          'content-type': 'image/png',
          'x-attachment-id': attachmentId,
          'x-command-id': nextId(),
          'x-issued-at': AT,
          'x-workspace-id': WORKSPACE_ID,
          'x-filename': 'layout.png',
        },
        body: bytes,
      });
      expect(uploaded.status).toBe(201);

      const res = await asUser('http://cockpit.test/v1/attachment-links', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ attachmentIds: [attachmentId] }),
      });

      expect(res.status).toBe(200);
      const { links } = (await res.json()) as { links: Record<string, string> };
      expect(Object.keys(links)).toEqual([attachmentId]);
      const opened = await SELF.fetch(links[attachmentId]!);
      expect(opened.status).toBe(200);
      expect(new Uint8Array(await opened.arrayBuffer())).toEqual(bytes);
    });

    it('opens nothing for an id that is not this account’s file', async () => {
      const res = await asUser('http://cockpit.test/v1/attachment-links', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ attachmentIds: [nextId()] }),
      });
      const { links } = (await res.json()) as { links: Record<string, string> };

      const opened = await SELF.fetch(Object.values(links)[0]!);

      expect(opened.status).toBe(404);
    });
  });
});
