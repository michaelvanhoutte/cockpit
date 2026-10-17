import { describe, expect, it, vi } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { ACCOUNT_NAME, WORKSPACE_ID, inStoreAsItIs, inTheStore } from '../seed.js';
import { handleQueue } from '../../../src/jobs/index.js';
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
 * before you look", issue 1161) through the real Worker, the real queue and
 * the real store, with the model faked at the network boundary - as
 * note-cleanup.test.ts does. Whether the real model proposes well is the
 * contract tier's (tests/contract/propose-for-claude.v1.test.ts); which answers
 * are kept is apps/api/tests/unit/ai/claude-proposals.test.ts.
 */

aModelThatReads();

const TO_CODE = {
  proposals: [
    { destination: 'code', label: 'Fix it', folder: '', prompt: 'In the Billing repository, fix the rounding.', why: '' },
  ],
};

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

/** Waits for a proposal call about this item whose words match, and answers the Item's proposals once written. */
async function untilProposedAbout(words: RegExp): Promise<void> {
  await vi.waitFor(() => expect(proposing.asked.some((call) => words.test(call.item))).toBe(true), {
    timeout: 15_000,
    interval: 50,
  });
}

async function untilItCarries(itemId: string, proposals: unknown): Promise<void> {
  await vi.waitFor(async () => expect(await proposalsOn(itemId)).toEqual(proposals), { timeout: 15_000, interval: 50 });
}

const AS_KEPT = [{ destination: 'code', label: 'Fix it', folder: '', prompt: 'In the Billing repository, fix the rounding.' }];

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
    it('writes a proposal onto a captured note, made from the words its clean-up gave it', async () => {
      proposing.answer = TO_CODE;

      const itemId = await captureANote();

      // The clean-up's rewrite asks again; this suite runs with no debounce
      // window, so the capture's own ask can run before it as well.
      await untilProposedAbout(new RegExp(A_READING.title));
      await untilItCarries(itemId, AS_KEPT);
    });

    it('sends where an Item from Gmail came from, and who sent it', async () => {
      const itemId = await captureANote();
      await untilItCarries(itemId, [{ destination: 'nothing', why: 'Nothing to do.' }]);
      await inTheStore((sql) => {
        sql.exec("UPDATE items SET source_connector = 'gmail', sender = 'Els Maes' WHERE id = ?", itemId);
      });
      proposing.asked.length = 0;

      await handleQueue(aProposalJob(itemId), env);

      expect(proposing.asked.map((call) => call.item)).toEqual([expect.stringContaining('Came from: Gmail, from Els Maes')]);
    });

    it('proposes again once the title is edited', async () => {
      const itemId = await captureANote();
      await untilItCarries(itemId, [{ destination: 'nothing', why: 'Nothing to do.' }]);
      proposing.answer = TO_CODE;

      const edited = await postChange('set_title', {
        commandId: nextId(),
        issuedAt: '2026-09-09T10:05:00.000Z',
        workspaceId: WORKSPACE_ID,
        itemId,
        title: 'Fix the rounding on invoices',
      });
      expect(edited.status).toBe(200);

      await untilProposedAbout(/Fix the rounding on invoices/);
      await untilItCarries(itemId, AS_KEPT);
    });

    it('proposes again once it is filed on a panel, naming the panel', async () => {
      const panelId = await aPanel('Billing bugs');
      const itemId = await captureANote();
      await untilItCarries(itemId, [{ destination: 'nothing', why: 'Nothing to do.' }]);
      proposing.answer = TO_CODE;

      await fileOnto(itemId, panelId);

      await untilProposedAbout(/Filed on: .* › Billing bugs/);
      await untilItCarries(itemId, AS_KEPT);
    });

    it.each([
      { situation: 'done', command: 'set_done' as const, field: { done: true } },
      { situation: 'dismissed', command: 'set_dismissed' as const, field: { dismissed: true } },
    ])('proposes nothing again for an Item that is $situation', async ({ command, field }) => {
      const itemId = await captureANote();
      await untilItCarries(itemId, [{ destination: 'nothing', why: 'Nothing to do.' }]);
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
});
