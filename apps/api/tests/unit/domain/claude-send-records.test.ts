import { describe, expect, it } from 'vitest';
import { claudeClosingFor, proposedPromptFor } from '@cockpit/shared';
import { closestSends, recordOfSend } from '../../../src/domain/claude-send-records.js';

/**
 * L1: what a send keeps, and which past sends are the closest to an Item
 * ("Learn from what you sent to Claude", issue 1162). The store these are read
 * from and the prompt they are shown in are the integration and contract
 * tiers'.
 */

const RUN = '018f0000-0000-7000-9000-000000000001';
const cmd = (over: Partial<Parameters<typeof recordOfSend>[0]> = {}): Parameters<typeof recordOfSend>[0] => ({
  runId: RUN,
  workspaceId: 'ws',
  itemId: 'it',
  destination: 'cowork',
  folder: '',
  issuedAt: '2026-10-16T10:00:00.000Z',
  prompt: 'Draft the reply.',
  proposed: { destination: 'cowork', folder: '', prompt: 'Draft the reply.' },
  ...over,
});

describe('Agents', () => {
  describe('a send keeps the task, without the parts Cockpit writes itself', () => {
    it('takes the line naming the sender, the files’ links and the closing out of both prompts', () => {
      const shown = proposedPromptFor({
        prompt: 'Draft a reply to Els.',
        runId: RUN,
        attachments: [{ id: 'a', filename: 'invoice.pdf', contentType: 'application/pdf', link: 'https://files.example/a' }],
        from: { source: 'Gmail', sender: 'Els Maes' },
      });

      const kept = recordOfSend(cmd({ prompt: shown, proposed: { destination: 'cowork', folder: '', prompt: shown } }), {
        title: 'Reply',
        description: null,
      });

      expect(kept).toMatchObject({ proposed: { prompt: 'Draft a reply to Els.' }, sent: { prompt: 'Draft a reply to Els.' } });
      expect(shown).toContain(claudeClosingFor(RUN));
    });

    it('keeps a part the person reworded, being theirs by then', () => {
      const kept = recordOfSend(cmd({ prompt: 'Draft it.\n\nStop before anything is sent.' }), { title: 'Reply', description: null });

      expect(kept?.sent.prompt).toBe('Draft it.\n\nStop before anything is sent.');
    });

    it.each([
      { situation: 'no prompt sent, from a tab from before sends were kept', over: { prompt: undefined } },
      { situation: 'no proposal sent', over: { proposed: undefined } },
      { situation: 'a prompt of nothing but Cockpit’s own parts', over: { prompt: claudeClosingFor(RUN) } },
    ])('keeps nothing for $situation', ({ over }) => {
      expect(recordOfSend(cmd(over), { title: 'Reply', description: null })).toBeNull();
    });

    it('keeps the Item’s words short, and the prompts to the longest a proposal may be', () => {
      const kept = recordOfSend(cmd({ prompt: 'x'.repeat(20_000) }), { title: 't'.repeat(900), description: 'd'.repeat(9_000) });

      expect([kept?.itemTitle.length, kept?.itemDescription?.length, kept?.sent.prompt.length]).toEqual([300, 1000, 8000]);
    });
  });

  describe('the closest past sends are the few most alike, one per Item, and none that are not alike', () => {
    const send = (itemId: string, reading: number[]) => ({ itemId, reading });

    it('orders by how alike, newest first on a tie, and stops at the bound', () => {
      const sends = [send('new', [1, 0]), send('same-again', [1, 0]), send('near', [1, 0.3]), send('nearer', [1, 0.1]), send('far', [1, 0.9])];

      expect(closestSends([1, 0], sends, 3).map((one) => one.itemId)).toEqual(['new', 'same-again', 'nearer']);
    });

    it('shows an Item sent several times once, by its newest send', () => {
      const sends = [{ itemId: 'a', reading: [1, 0], at: 'newest' }, { itemId: 'a', reading: [1, 0], at: 'oldest' }];

      expect(closestSends([1, 0], sends)).toEqual([sends[0]]);
    });

    it('leaves out a send for an Item that reads as something else, or as nothing', () => {
      expect(closestSends([1, 0], [send('unrelated', [0, 1]), send('emptied', [])])).toEqual([]);
    });
  });
});
