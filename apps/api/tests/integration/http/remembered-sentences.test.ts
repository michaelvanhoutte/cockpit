import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { ACCOUNT_NAME, WORKSPACE_ID, alsoWorkspaces, asUser, inStoreAsItIs, inTheStore } from '../seed.js';
import { handleQueue } from '../../../src/jobs/index.js';
import type { EnrichmentJob } from '../../../src/jobs/enrichment.js';
import { ACCOUNT_WIDE, rememberOfferAnswerSchema } from '@cockpit/shared';
import {
  aModelThatReads,
  batchOf,
  captureANote,
  nextId,
  offering,
  postChange,
  proposing,
} from './note-cleanup.support.js';

/**
 * L2: remembering an edit as a sentence ("Remember an edit as a sentence you
 * confirm", issue 1163) through the real Worker and the real store, with the
 * model faked at the network boundary as claude-proposals.test.ts does. Whether
 * the real model words a sentence or follows one is the contract tier's
 * (tests/contract/remember-a-sentence.v1.test.ts and propose-for-claude.v4.test.ts);
 * which answers are shown is apps/api/tests/unit/ai/sentence-offers.test.ts; which
 * sentences fit an Item is apps/api/tests/unit/domain/remembered-sentences.test.ts.
 *
 * **The queue is held, and read by hand**, so nothing here depends on when a
 * background job runs.
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

const AT = '2026-10-17T10:00:00.000Z';
const PROPOSED = 'Draft a reply to the accountant about the VAT return.';
const EDITED = 'Schrijf kort een antwoord aan de boekhouder over de btw-aangifte, ondertekend door Michael.';
const SENTENCE = 'Mails to the accountant: Dutch, short, signed Michael.';

/** An Item that is open, from the given kind of source, in a Workspace or in none yet. */
async function anItem(options: { source?: string; workspaceId?: string; decided?: boolean; done?: boolean; updatedAt?: string } = {}) {
  const workspaceId = options.workspaceId ?? WORKSPACE_ID;
  const itemId = await captureANote({ itemId: nextId(), workspaceId });
  await inTheStore((sql) => {
    sql.exec(
      'UPDATE items SET source_connector = ?, workspace_decided = ?, completed_at = ?, updated_at = COALESCE(?, updated_at) WHERE id = ?',
      options.source ?? 'gmail',
      options.decided === false ? 0 : 1,
      options.done ? AT : null,
      options.updatedAt ?? null,
      itemId,
    );
  });
  return itemId;
}

/** Sends an Item to Claude as the window does, leaving the record a later offer is made from. */
async function sentWith(itemId: string, prompt: string, proposed = PROPOSED, folder = ''): Promise<string> {
  const runId = nextId();
  const answer = await postChange('send_item_to_claude', {
    commandId: nextId(),
    issuedAt: AT,
    workspaceId: WORKSPACE_ID,
    itemId,
    runId,
    destination: 'cowork',
    folder,
    prompt,
    proposed: { destination: 'cowork', folder, prompt: proposed },
  });
  expect(answer.status).toBe(200);
  return runId;
}

async function offerFor(runId: string) {
  const res = await asUser(`http://cockpit.test/v1/claude-sends/${runId}/remember-offer`, { method: 'POST' });
  expect(res.status).toBe(200);
  return ((await res.json()) as { offer: Record<string, unknown> | null }).offer;
}

async function remember(sentence: string, options: { workspaceId?: string; sourceKind?: string; sentenceId?: string } = {}) {
  const sentenceId = options.sentenceId ?? nextId();
  const answer = await postChange('remember_sentence', {
    commandId: nextId(),
    issuedAt: AT,
    workspaceId: options.workspaceId ?? ACCOUNT_WIDE,
    sentenceId,
    sentence,
    action: 'reply to a mail',
    sourceKind: options.sourceKind ?? 'gmail',
  });
  expect(answer.status).toBe(200);
  return sentenceId;
}

type KeptSentence = {
  id: string;
  sentence: string;
  workspace_id: string | null;
  use_count: number;
  last_used_at: string | null;
};

async function remembered(): Promise<KeptSentence[]> {
  return inStoreAsItIs(ACCOUNT_NAME, (sql) =>
    sql
      .exec<KeptSentence>('SELECT id, sentence, workspace_id, use_count, last_used_at FROM remembered_sentences ORDER BY created_at, id')
      .toArray(),
  );
}

async function sendsKept(): Promise<number> {
  return inStoreAsItIs(ACCOUNT_NAME, (sql) => sql.exec<{ n: number }>('SELECT count(*) AS n FROM claude_sends').one().n);
}

/** What the model is sent for one Item's proposal, with the queue's own job handed to the real consumer. */
async function sentForProposalOf(itemId: string): Promise<string> {
  proposing.asked.length = 0;
  await handleQueue(
    batchOf({ kind: 'propose-for-claude', accountName: ACCOUNT_NAME, itemId, ask: { at: Date.now(), id: crypto.randomUUID() } }),
    env,
  );
  expect(proposing.asked).toHaveLength(1);
  return proposing.asked[0]!.item;
}

describe('Agents', () => {
  describe('a sentence is offered only after an edit, and kept only when you say so', () => {
    it('asks the model nothing, and offers nothing, for a send that changed nothing', async () => {
      const runId = await sentWith(await anItem(), PROPOSED);

      expect(await offerFor(runId)).toBeNull();
      expect(offering.asked).toHaveLength(0);
    });

    it('offers the sentence the model words for an edited send, from the proposed and the sent prompts', async () => {
      offering.answer = { sentence: SENTENCE, action: 'reply to a mail', workspace: '' };
      const runId = await sentWith(await anItem(), EDITED);

      expect(await offerFor(runId)).toEqual({
        sentence: SENTENCE,
        action: 'reply to a mail',
        workspaceId: null,
        workspaceName: null,
        sourceKind: 'gmail',
      });
      expect(offering.asked).toHaveLength(1);
      expect(offering.asked[0]!.item).toContain(JSON.stringify(PROPOSED));
      expect(offering.asked[0]!.item).toContain(JSON.stringify(EDITED));
    });

    it('offers a sentence for the first workspace, whose id is ws-1, in a body the window accepts', async () => {
      offering.answer = { sentence: SENTENCE, action: 'reply to a mail', workspace: 'Workspace 1' };
      const runId = await sentWith(await anItem(), EDITED);

      const res = await asUser(`http://cockpit.test/v1/claude-sends/${runId}/remember-offer`, { method: 'POST' });
      const answer = rememberOfferAnswerSchema.parse(await res.json());

      expect(answer.offer).toMatchObject({ workspaceId: WORKSPACE_ID, workspaceName: 'Workspace 1' });
    });

    it('offers nothing, and keeps the send, where the model cannot be reached', async () => {
      offering.fails = true;
      const runId = await sentWith(await anItem(), EDITED);

      expect(await offerFor(runId)).toBeNull();
      expect(await sendsKept()).toBe(1);
    });

    it('offers nothing where the model finds nothing worth remembering', async () => {
      const runId = await sentWith(await anItem(), EDITED);

      expect(await offerFor(runId)).toBeNull();
      expect(offering.asked).toHaveLength(1);
    });

    it('keeps nothing from an offer that is never accepted', async () => {
      offering.answer = { sentence: SENTENCE, action: 'reply to a mail', workspace: '' };
      const runId = await sentWith(await anItem(), EDITED);

      await offerFor(runId);

      expect(await remembered()).toEqual([]);
    });

    it('keeps the sentence as the person reworded it, once however many times Remember is pressed', async () => {
      const sentenceId = await remember('Mails to the accountant: Dutch, very short, signed M.');
      await remember('Mails to the accountant: Dutch, very short, signed M.', { sentenceId });

      expect(await remembered()).toEqual([
        expect.objectContaining({ sentence: 'Mails to the accountant: Dutch, very short, signed M.', workspace_id: null, use_count: 0 }),
      ]);
    });
  });

  describe('a remembered sentence shapes the proposals it fits, and only those', () => {
    it('is shown to a proposal for an Item from the same kind of source, and not to one from another', async () => {
      await remember(SENTENCE);
      const mail = await anItem({ source: 'gmail' });
      const chat = await anItem({ source: 'teams' });

      expect(await sentForProposalOf(mail)).toContain(JSON.stringify(SENTENCE));
      expect(await sentForProposalOf(chat)).not.toContain(SENTENCE);
    });

    it('is shown only to the Items of the Workspace it names, and to an Item in none yet only where it names none', async () => {
      await alsoWorkspaces();
      await remember('In Atlas: sign as the team.', { workspaceId: 'ws-atlas' });
      await remember(SENTENCE);
      const inAtlas = await anItem({ workspaceId: 'ws-atlas' });
      const inTheFirst = await anItem();
      const inNone = await anItem({ decided: false });

      const inAtlasSent = await sentForProposalOf(inAtlas);
      const inTheFirstSent = await sentForProposalOf(inTheFirst);
      const inNoneSent = await sentForProposalOf(inNone);

      expect(inAtlasSent).toContain('In Atlas: sign as the team.');
      expect(inAtlasSent).toContain(SENTENCE);
      expect(inTheFirstSent).not.toContain('In Atlas');
      expect(inTheFirstSent).toContain(SENTENCE);
      expect(inNoneSent).not.toContain('In Atlas');
      expect(inNoneSent).toContain(SENTENCE);
    });

    it('proposes again the open Items it may fit, and leaves the rest untouched', async () => {
      await alsoWorkspaces();
      // The oldest last, so that when it is queued everything newer already has been.
      const fitting = [
        await anItem({ updatedAt: '2026-10-17T09:03:00.000Z' }),
        await anItem({ updatedAt: '2026-10-17T09:02:00.000Z' }),
        await anItem({ updatedAt: '2026-10-17T09:01:00.000Z' }),
      ];
      await anItem({ source: 'teams', updatedAt: '2026-10-17T09:04:00.000Z' });
      await anItem({ done: true, updatedAt: '2026-10-17T09:05:00.000Z' });
      await anItem({ workspaceId: 'ws-atlas', updatedAt: '2026-10-17T09:06:00.000Z' });
      held.length = 0;

      // Naming the first Workspace, as a sentence about it does.
      await remember('In this workspace: reply in Dutch.', { workspaceId: WORKSPACE_ID });
      await vi.waitFor(
        () => expect(held.some((job) => job.kind === 'propose-for-claude' && job.itemId === fitting[2])).toBe(true),
        { timeout: 15_000, interval: 25 },
      );

      expect(
        held.filter((job) => job.kind === 'propose-for-claude').map((job) => ('itemId' in job ? job.itemId : null)),
      ).toEqual(fitting);
      // And what was queued is a job the consumer takes: one it refuses is a proposal that is never made.
      const queued = held.find((job) => job.kind === 'propose-for-claude' && job.itemId === fitting[2])!;
      proposing.asked.length = 0;
      await handleQueue(batchOf(queued), env);
      expect(proposing.asked).toHaveLength(1);
      expect(proposing.asked[0]!.item).toContain(JSON.stringify('In this workspace: reply in Dutch.'));
    });

    it('counts each time it shaped a proposal that was written, and no other', async () => {
      const sentenceId = await remember(SENTENCE);
      const mail = await anItem({ source: 'gmail' });
      const chat = await anItem({ source: 'teams' });
      proposing.answer = {
        proposals: [{ destination: 'cowork', label: 'Reply', folder: '', prompt: 'Draft a reply.', why: '' }],
      };

      await sentForProposalOf(mail);
      await sentForProposalOf(chat);
      expect((await remembered()).find((one) => one.id === sentenceId)).toMatchObject({ use_count: 1 });

      await sentForProposalOf(mail);
      const [kept] = await remembered();
      expect(kept).toMatchObject({ id: sentenceId, use_count: 2 });
      expect(kept!.last_used_at).not.toBeNull();
    });
  });
});
