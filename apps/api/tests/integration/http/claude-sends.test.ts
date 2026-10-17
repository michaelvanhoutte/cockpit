import { beforeEach, describe, expect, inject, it } from 'vitest';
import { SELF, applyD1Migrations, env } from 'cloudflare:test';
import { claudeClosingFor, plainPromptFor } from '@cockpit/shared';
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
 * which is the web app's own F1 test; and an Agent's run kept from before
 * Agents were retired, which is agent-runs-retired.test.ts's.
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
    prompt?: string;
    proposed?: { destination: 'cowork' | 'code'; folder: string; prompt: string };
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
      ...(options.prompt === undefined ? {} : { prompt: options.prompt }),
      ...(options.proposed === undefined ? {} : { proposed: options.proposed }),
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

    it('takes a retry under a new command id, after a lost answer, as the Run already made', async () => {
      const itemId = await anItem('Chase the invoice');
      const runId = nextId();

      await send(itemId, { runId });
      const retry = await send(itemId, { runId });

      expect(retry.status).toBe(200);
      expect(await retry.json()).toMatchObject({ applied: false });
      expect(await allRuns(itemId)).toHaveLength(1);
    });

    it('shows the Run in another workspace’s Inbox while the item belongs to no workspace', async () => {
      const itemId = nextId();
      expect(
        (
          await postChange('capture_item', {
            workspaceId: WORKSPACE_ID,
            itemId,
            message: 'Not yet anywhere',
            workspaceDecided: false,
          })
        ).status,
      ).toBe(200);

      expect((await send(itemId)).status).toBe(200);

      expect(await runsOn(itemId, ATLAS)).toEqual([expect.objectContaining({ itemId, destination: 'cowork' })]);
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

    it('makes no address for an id that is not this account’s file', async () => {
      const res = await asUser('http://cockpit.test/v1/attachment-links', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ attachmentIds: [nextId()] }),
      });

      expect({ status: res.status, body: await res.json() }).toEqual({ status: 200, body: { links: {} } });
    });
  });

  describe('every Open keeps exactly what was proposed and what was sent', () => {
    const PROPOSED = 'Draft a reply to Els Maes about the release notes.';

    /** Every record kept, with the Run it belongs to. */
    async function recordsOn(itemId: string) {
      return inTheStore((sql) => [
        ...sql.exec<{
          id: string;
          item_title: string;
          proposed_destination: string;
          proposed_folder: string;
          proposed_prompt: string;
          sent_destination: string;
          sent_folder: string;
          sent_prompt: string;
        }>(
          `SELECT id, item_title, proposed_destination, proposed_folder, proposed_prompt, sent_destination, sent_folder, sent_prompt
             FROM claude_sends WHERE item_id = ? ORDER BY sent_at, id`,
          itemId,
        ),
      ]);
    }

    /** A prompt as the window sends it: the task, the files' links, the closing naming the Run. */
    const asWindowSends = (task: string, runId: string) =>
      [
        task,
        'Attachments - download each link and read the file. A link works for an hour, without signing in.\n- invoice.pdf: https://files.example/a',
        claudeClosingFor(runId),
      ].join('\n\n');

    it('keeps one record, the proposal and the send equal, where the proposal was sent as it was', async () => {
      const itemId = await anItem('Release notes for Els');
      const runId = nextId();
      const prompt = asWindowSends(PROPOSED, runId);

      const res = await send(itemId, {
        runId,
        destination: 'cowork',
        prompt,
        proposed: { destination: 'cowork', folder: '', prompt },
      });

      expect(res.status).toBe(200);
      expect(await recordsOn(itemId)).toEqual([
        {
          id: runId,
          item_title: 'Release notes for Els',
          proposed_destination: 'cowork',
          proposed_folder: '',
          proposed_prompt: PROPOSED,
          sent_destination: 'cowork',
          sent_folder: '',
          sent_prompt: PROPOSED,
        },
      ]);
    });

    it('keeps the edited prompt, the changed folder and the flipped switch as sent, beside what was proposed', async () => {
      const itemId = await anItem('Release notes for Els');
      const runId = nextId();

      await send(itemId, {
        runId,
        destination: 'code',
        folder: 'C:\\GitHub\\conselit',
        prompt: asWindowSends('In the conselit repository, write the release notes.', runId),
        proposed: { destination: 'cowork', folder: '', prompt: asWindowSends(PROPOSED, runId) },
      });

      expect(await recordsOn(itemId)).toEqual([
        expect.objectContaining({
          proposed_destination: 'cowork',
          proposed_folder: '',
          proposed_prompt: PROPOSED,
          sent_destination: 'code',
          sent_folder: 'C:\\GitHub\\conselit',
          sent_prompt: 'In the conselit repository, write the release notes.',
        }),
      ]);
    });

    it('keeps no proposed prompt where none had been made yet, so the plain one is not a proposal accepted', async () => {
      const itemId = await anItem('Chase the invoice');
      const runId = nextId();
      const plain = plainPromptFor({ title: 'Chase the invoice', description: null, attachments: [], runId });

      await send(itemId, { runId, prompt: plain, proposed: { destination: 'cowork', folder: '', prompt: '' } });

      expect(await recordsOn(itemId)).toEqual([
        expect.objectContaining({ proposed_prompt: '', sent_prompt: 'Chase the invoice' }),
      ]);
    });

    it('keeps one record for the same Open sent twice', async () => {
      const itemId = await anItem('Chase the invoice');
      const runId = nextId();
      const asked = { runId, prompt: 'Chase it.', proposed: { destination: 'cowork' as const, folder: '', prompt: 'Chase it.' } };

      await send(itemId, asked);
      await send(itemId, asked);

      expect(await recordsOn(itemId)).toHaveLength(1);
    });

    it.each([
      { situation: 'a tab from before sends were kept, which sends no prompt', options: {} },
      { situation: 'a prompt of nothing but what Cockpit writes itself', options: { closingOnly: true } },
    ])('keeps no record for $situation', async ({ options }) => {
      const itemId = await anItem('Chase the invoice');
      const runId = nextId();
      const prompt = 'closingOnly' in options ? claudeClosingFor(runId) : undefined;

      await send(itemId, {
        runId,
        ...(prompt === undefined ? {} : { prompt, proposed: { destination: 'cowork' as const, folder: '', prompt } }),
      });

      expect(await recordsOn(itemId)).toEqual([]);
      expect(await allRuns(itemId)).toHaveLength(1);
    });

    it('keeps no record of a send the server refused, and none of the prompts in the log of changes', async () => {
      const itemId = await anItem('Chase the invoice');
      const first = nextId();
      await send(itemId, { runId: first, prompt: 'First task.', proposed: { destination: 'cowork', folder: '', prompt: 'First task.' } });
      await inTheStore((sql) => {
        sql.exec("UPDATE agent_runs SET status = 'working' WHERE id = ?", first);
      });

      const second = nextId();
      const refused = await send(itemId, {
        runId: second,
        prompt: 'Second task, secret words.',
        proposed: { destination: 'cowork', folder: '', prompt: 'Second task, secret words.' },
      });

      expect(refused.status).toBe(409);
      expect((await recordsOn(itemId)).map((one) => one.id)).toEqual([first]);
      const logged = await inTheStore((sql) => [...sql.exec<{ payload: string }>("SELECT payload FROM commands WHERE name = 'send_item_to_claude'")]);
      expect(logged.map((one) => one.payload).join('')).not.toMatch(/First task|secret words/);
    });
  });
});