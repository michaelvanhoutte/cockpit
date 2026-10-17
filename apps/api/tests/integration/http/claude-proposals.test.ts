import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { ACCOUNT_NAME, WORKSPACE_ID, alsoWorkspaces, inStoreAsItIs, inTheStore } from '../seed.js';
import { enqueueProposalForClaude, handleQueue } from '../../../src/jobs/index.js';
import type { EnrichmentJob } from '../../../src/jobs/enrichment.js';
import { GUEST_ACCOUNT_NAME } from '../../../src/accounts/new-user.js';
import {
  A_READING,
  aModelThatReads,
  aPanel,
  batchOf,
  captureANote,
  fileOnto,
  nextId,
  postChange,
  proposing,
} from './note-cleanup.support.js';

/**
 * L2: proposing what to do with an Item ("Propose what to do with each item
 * before you look", issue 1161) through the real Worker, the real consumer and
 * the real store, with the model faked at the network boundary - as
 * note-cleanup.test.ts does. Whether the real model proposes well is the
 * contract tier's (tests/contract/propose-for-claude.v3.test.ts); which answers
 * are kept is apps/api/tests/unit/ai/claude-proposals.test.ts.
 *
 * **The queue is held, and drained by hand** (`delivered`), as
 * correcting-a-text-reads-nothing.test.ts does: a capture queues a proposal
 * and its clean-up queues another, and a case that waits for one of them on
 * the real queue cannot tell whether the other is still to land.
 */

aModelThatReads();

let held: EnrichmentJob[] = [];
let realQueue: typeof env.ENRICHMENT;

beforeEach(() => {
  held = [];
  realQueue = env.ENRICHMENT;
  env.ENRICHMENT = {
    send: async (body: EnrichmentJob) => {
      held.push(body);
    },
    sendBatch: async () => {
      throw new Error('nothing here sends a batch');
    },
  } as unknown as typeof env.ENRICHMENT;
});

afterEach(() => {
  env.ENRICHMENT = realQueue;
});

/** Waits for a change's own queueing, which runs after it has answered, to have held a job of this kind for the Item. */
async function untilQueued(kind: EnrichmentJob['kind'], itemId: string): Promise<void> {
  await vi.waitFor(() => expect(held.some((job) => job.kind === kind && 'itemId' in job && job.itemId === itemId)).toBe(true), {
    timeout: 15_000,
    interval: 25,
  });
}

/**
 * Delivers everything held, and whatever that queues in turn, through the real
 * consumer - every other job before a proposal, as the debounce window lets a
 * clean-up land before the proposals asked around it run.
 */
async function delivered(): Promise<void> {
  for (;;) {
    const next = held.find((job) => job.kind !== 'propose-for-claude') ?? held[0];
    if (!next) return;
    held.splice(held.indexOf(next), 1);
    await handleQueue(batchOf(next), env);
  }
}

/** A note captured, cleaned up and proposed for, with every job it queued delivered. */
async function aSettledNote(): Promise<string> {
  const itemId = await captureANote();
  await untilQueued('clean-up-a-note', itemId);
  await untilQueued('propose-for-claude', itemId);
  await delivered();
  return itemId;
}

const TO_CODE = {
  proposals: [
    { destination: 'code', label: 'Fix it', folder: '', prompt: 'In the Billing repository, fix the rounding.', why: '' },
  ],
};

const AS_KEPT = [{ destination: 'code', label: 'Fix it', folder: '', prompt: 'In the Billing repository, fix the rounding.' }];

const NOTHING_KEPT = [{ destination: 'nothing', why: 'Nothing to do.' }];

/** What the Item carries, read straight out of the store. */
async function proposalsOn(itemId: string, accountName = ACCOUNT_NAME): Promise<unknown> {
  const rows = await inStoreAsItIs(accountName, (sql) =>
    sql
      .exec<{ claude_proposals: string | null }>(
        'SELECT claude_proposals FROM items WHERE id = ? AND tenant_id = ?',
        itemId,
        accountName,
      )
      .toArray(),
  );
  const stored = rows[0]?.claude_proposals ?? null;
  return stored === null ? null : JSON.parse(stored);
}

/** A proposal job for one Item, as the queue would hand it over, asked for now. */
function aProposalJob(itemId: string) {
  return batchOf({
    kind: 'propose-for-claude',
    accountName: ACCOUNT_NAME,
    itemId,
    ask: { at: Date.now(), id: crypto.randomUUID() },
  });
}

describe('Agents', () => {
  describe('a proposal is made when an Item arrives and redone when what it was made from changes', () => {
    it('writes one proposal onto a captured note, made from the words its clean-up gave it', async () => {
      proposing.answer = TO_CODE;

      const itemId = await aSettledNote();

      // The capture's own ask gave way to the clean-up's: one call, on the new words.
      expect(proposing.asked.map((call) => call.item)).toEqual([expect.stringContaining(`Title: "${A_READING.title}"`)]);
      expect(await proposalsOn(itemId)).toEqual(AS_KEPT);
    });

    it('sends where an Item from Gmail came from, and who sent it', async () => {
      const itemId = await aSettledNote();
      await inTheStore((sql) => {
        sql.exec("UPDATE items SET source_connector = 'gmail', sender = 'Els Maes' WHERE id = ?", itemId);
      });
      proposing.asked.length = 0;

      await handleQueue(aProposalJob(itemId), env);

      expect(proposing.asked.map((call) => call.item)).toEqual([expect.stringContaining('Came from: Gmail, from "Els Maes"')]);
    });

    it('offers only the folders sent to from its own workspace, and every folder for an item in none yet', async () => {
      await alsoWorkspaces();
      const itemId = await aSettledNote();
      await inTheStore((sql) => {
        for (const [id, workspaceId, folder] of [
          ['run-own', WORKSPACE_ID, 'C:\\Code\\own-repo'],
          ['run-other', 'ws-atlas', 'C:\\Code\\other-repo'],
        ] as const) {
          sql.exec(
            `INSERT INTO agent_runs (id, tenant_id, workspace_id, item_id, agent_id, status, started_at, ended_at, destination, folder)
             VALUES (?, ?, ?, ?, 'claude', 'working', '2026-09-09T10:00:00.000Z', '2026-09-09T10:01:00.000Z', 'code', ?)`,
            id,
            ACCOUNT_NAME,
            workspaceId,
            itemId,
            folder,
          );
        }
      });
      const foldersOffered = async () => {
        proposing.asked.length = 0;
        await handleQueue(aProposalJob(itemId), env);
        return proposing.asked[0]!.system;
      };

      const inItsWorkspace = await foldersOffered();
      await inTheStore((sql) => {
        sql.exec('UPDATE items SET workspace_decided = 0 WHERE id = ?', itemId);
      });
      const inNone = await foldersOffered();

      expect(inItsWorkspace).toContain('own-repo');
      expect(inItsWorkspace).not.toContain('other-repo');
      expect(inNone).toContain('own-repo');
      expect(inNone).toContain('other-repo');
    });

    it('proposes again once the title is edited', async () => {
      const itemId = await aSettledNote();
      expect(await proposalsOn(itemId)).toEqual(NOTHING_KEPT);
      proposing.answer = TO_CODE;

      const edited = await postChange('set_title', {
        commandId: nextId(),
        issuedAt: '2026-09-09T10:05:00.000Z',
        workspaceId: WORKSPACE_ID,
        itemId,
        title: 'Fix the rounding on invoices',
      });
      expect(edited.status).toBe(200);
      await untilQueued('propose-for-claude', itemId);
      await delivered();

      expect(proposing.asked.at(-1)?.item).toMatch(/Fix the rounding on invoices/);
      expect(await proposalsOn(itemId)).toEqual(AS_KEPT);
    });

    it.each([
      { situation: 'filed on a panel', filed: /Filed on: .* › Billing bugs/, removed: false },
      { situation: 'taken off that panel again', filed: /Filed on: the inbox, on no panel yet/, removed: true },
    ])('proposes again once it is $situation, naming where it is', async ({ filed, removed }) => {
      const panelId = await aPanel('Billing bugs');
      const itemId = await aSettledNote();
      if (removed) {
        await fileOnto(itemId, panelId);
        await untilQueued('propose-for-claude', itemId);
        await delivered();
        const off = await postChange('remove_item_from_panel', {
          commandId: nextId(),
          issuedAt: '2026-09-09T10:05:00.000Z',
          workspaceId: WORKSPACE_ID,
          itemId,
          panelId,
        });
        expect(off.status).toBe(200);
      } else {
        await fileOnto(itemId, panelId);
      }
      proposing.answer = TO_CODE;
      await untilQueued('propose-for-claude', itemId);
      await delivered();

      expect(proposing.asked.at(-1)?.item).toMatch(filed);
      expect(await proposalsOn(itemId)).toEqual(AS_KEPT);
    });

    it('writes nothing where it was filed while the proposal was being made, leaving it to the one the filing asked for', async () => {
      const panelId = await aPanel('Billing bugs');
      const itemId = await aSettledNote();
      proposing.answer = TO_CODE;
      proposing.during = async () => {
        proposing.during = null;
        await fileOnto(itemId, panelId);
        // What the filing queues, asked here so it is recorded before the answer comes back.
        await enqueueProposalForClaude(env, ACCOUNT_NAME, itemId, 'item-changed');
      };

      await handleQueue(aProposalJob(itemId), env);

      expect(await proposalsOn(itemId)).toEqual(NOTHING_KEPT);
      await untilQueued('propose-for-claude', itemId);
      await delivered();
      expect(proposing.asked.at(-1)?.item).toMatch(/Filed on: .* › Billing bugs/);
      expect(await proposalsOn(itemId)).toEqual(AS_KEPT);
    });

    it('proposes again where it was changed some other way while the proposal was being made', async () => {
      const itemId = await aSettledNote();
      proposing.answer = TO_CODE;
      proposing.during = async () => {
        proposing.during = null;
        // A priority, which asks for no proposal of its own.
        const changed = await postChange('set_priority', {
          commandId: nextId(),
          issuedAt: '2026-09-09T10:05:00.000Z',
          workspaceId: WORKSPACE_ID,
          itemId,
          priority: 'high',
        });
        expect(changed.status).toBe(200);
      };

      await handleQueue(aProposalJob(itemId), env);

      expect(await proposalsOn(itemId)).toEqual(NOTHING_KEPT);
      await untilQueued('propose-for-claude', itemId);
      await delivered();
      expect(await proposalsOn(itemId)).toEqual(AS_KEPT);
    });

    it.each([
      { situation: 'done', command: 'set_done' as const, field: { done: true } },
      { situation: 'dismissed', command: 'set_dismissed' as const, field: { dismissed: true } },
    ])('proposes nothing again for an Item that is $situation', async ({ command, field }) => {
      const itemId = await aSettledNote();
      const closed = await postChange(command, {
        commandId: nextId(),
        issuedAt: '2026-09-09T10:05:00.000Z',
        workspaceId: WORKSPACE_ID,
        itemId,
        ...field,
      } as never);
      expect(closed.status).toBe(200);
      proposing.asked.length = 0;

      await handleQueue(aProposalJob(itemId), env);

      expect(proposing.asked).toEqual([]);
    });

    it('queues nothing for the guest account, whose items carry seeded proposals instead', async () => {
      const back = await SELF.fetch('http://cockpit.test/v1/sign-in/guest', { redirect: 'manual' });
      const cookie = back.headers
        .getSetCookie()
        .map((one) => one.split(';')[0]!)
        .find((one) => one.startsWith('cockpit_session='))!;
      const listed = await SELF.fetch('http://cockpit.test/v1/workspaces', { headers: { cookie } });
      const [first] = ((await listed.json()) as { workspaces: { id: string }[] }).workspaces;
      const sent = vi.spyOn(env.ENRICHMENT, 'send');

      const captured = await SELF.fetch('http://cockpit.test/v1/commands/capture_item', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({
          commandId: nextId(),
          issuedAt: '2026-09-09T10:00:00.000Z',
          workspaceId: first!.id,
          itemId: nextId(),
          message: 'Book the car in for its service',
        }),
      });
      expect(captured.status).toBe(200);
      sent.mockRestore();
      const someSeeded = await inStoreAsItIs(GUEST_ACCOUNT_NAME, (sql) =>
        sql.exec('SELECT 1 FROM items WHERE claude_proposals IS NOT NULL').toArray(),
      );

      expect(sent.mock.calls.filter(([job]) => (job as { kind: string }).kind === 'propose-for-claude')).toEqual([]);
      expect(someSeeded.length).toBeGreaterThan(0);
    });
  });

  describe('a proposal is shaped by the closest past sends, and only the account’s own', () => {
    const MODEL = '@cf/baai/bge-m3';
    /** What the Item being proposed for means; past sends are placed by how near their Item's meaning is to it. */
    const THIS_ITEM = [1, 0, 0];

    async function readAs(itemId: string, reading: number[]): Promise<void> {
      await inTheStore((sql) => {
        sql.exec(
          `INSERT INTO item_meanings (item_id, tenant_id, model, reading, read_at) VALUES (?, ?, ?, ?, '2026-09-09T10:00:00.000Z')
             ON CONFLICT(item_id) DO UPDATE SET reading = excluded.reading, model = excluded.model`,
          itemId,
          ACCOUNT_NAME,
          MODEL,
          JSON.stringify(reading),
        );
      });
    }

    /** A send for another Item, which means `reading`, with the words that make it findable in what is sent. */
    async function aPastSend(
      reading: number[],
      words: string,
      options: { tenant?: string; workspaceId?: string; sentAt?: string; folder?: string } = {},
    ): Promise<void> {
      const itemId = await captureANote({ itemId: nextId() });
      await readAs(itemId, reading);
      await inTheStore((sql) => {
        sql.exec(
          `INSERT INTO claude_sends (id, tenant_id, workspace_id, item_id, item_title, item_description,
                                     proposed_destination, proposed_folder, proposed_prompt,
                                     sent_destination, sent_folder, sent_prompt, sent_at)
           VALUES (?, ?, ?, ?, ?, NULL, 'cowork', '', ?, 'code', ?, ?, ?)`,
          nextId(),
          options.tenant ?? ACCOUNT_NAME,
          options.workspaceId ?? WORKSPACE_ID,
          itemId,
          words,
          `proposed ${words}`,
          options.folder ?? '',
          `sent ${words}`,
          options.sentAt ?? '2026-09-09T11:00:00.000Z',
        );
      });
    }

    /** What the model is sent for an Item that means THIS_ITEM. */
    async function sentForANewItem(): Promise<string> {
      const itemId = await aSettledNote();
      await readAs(itemId, THIS_ITEM);
      proposing.asked.length = 0;
      await handleQueue(aProposalJob(itemId), env);
      expect(proposing.asked).toHaveLength(1);
      return proposing.asked[0]!.system;
    }

    it('shows a past send for a similar Item, with what was proposed and what was sent', async () => {
      await aPastSend([0.9, 0.1, 0], 'conselit contact form', { folder: 'C:\\GitHub\\conselit' });

      const sent = await sentForANewItem();

      expect(sent).toContain('conselit contact form');
      expect(sent).toContain('proposed conselit contact form');
      expect(sent).toContain('sent conselit contact form');
    });

    it('leaves out a past send for an unrelated Item', async () => {
      await aPastSend([0, 1, 0], 'volleyball club fees');

      expect(await sentForANewItem()).not.toContain('volleyball club fees');
    });

    it('is made as before where nothing was ever sent', async () => {
      const sent = await sentForANewItem();

      expect(sent).not.toContain('Past sends from this account');
    });

    it.each([
      { situation: 'another account’s', options: { tenant: 'someone-else' } },
      { situation: 'another workspace’s, for an Item that is in one', options: { workspaceId: 'ws-atlas' } },
    ])('never shows $situation sends', async ({ options }) => {
      await alsoWorkspaces();
      await aPastSend([1, 0, 0], 'somebody else’s send', options);

      expect(await sentForANewItem()).not.toContain('somebody else’s send');
    });

    it('shows only the closest, up to the bound, closest first', async () => {
      for (const at of [5, 1, 4, 2, 3]) await aPastSend([1, at * 0.15, 0], `send number ${at}`);

      const sent = await sentForANewItem();

      expect([1, 2, 3].map((at) => sent.indexOf(`send number ${at}`)).every((where) => where >= 0)).toBe(true);
      expect(sent.indexOf('send number 1')).toBeLessThan(sent.indexOf('send number 2'));
      expect(sent.indexOf('send number 2')).toBeLessThan(sent.indexOf('send number 3'));
      expect(sent).not.toContain('send number 4');
      expect(sent).not.toContain('send number 5');
    });

    it('names a folder sent to by its number in the list offered, never by its path alone', async () => {
      const itemId = await aSettledNote();
      await inTheStore((sql) => {
        sql.exec(
          `INSERT INTO agent_runs (id, tenant_id, workspace_id, item_id, agent_id, status, started_at, ended_at, destination, folder)
           VALUES ('run-conselit', ?, ?, ?, 'claude', 'working', '2026-09-09T10:00:00.000Z', '2026-09-09T10:01:00.000Z', 'code', 'C:\\GitHub\\conselit')`,
          ACCOUNT_NAME,
          WORKSPACE_ID,
          itemId,
        );
      });
      await aPastSend([0.9, 0.1, 0], 'conselit contact form', { folder: 'C:\\GitHub\\conselit' });
      await readAs(itemId, THIS_ITEM);
      proposing.asked.length = 0;

      await handleQueue(aProposalJob(itemId), env);

      expect(proposing.asked[0]!.system).toMatch(/Sent: code, folder 1, prompt "sent conselit contact form"/);
    });
  });
});