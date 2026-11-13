import { afterEach, describe, expect, it, vi } from 'vitest';
import { DraftRefused, makeADraft } from '../../../src/api/drafts';

/**
 * L1: how the Worker's answer to *Email…* or *Reply…* is read; the fetch is the
 * network, which jsdom has none of. What the row then says is ItemRow.test.tsx.
 */

afterEach(() => vi.unstubAllGlobals());

function workerAnswers(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status })));
}

describe('Triage', () => {
  describe('a draft not made is said to have put the Item back only where the server put it back', () => {
    it.each([
      { situation: 'the mailbox would not make the draft', status: 502, body: { error: 'Gmail refused the draft', putBack: true }, putBack: true },
      // Issue 1720: the mailbox not answering whether the draft started before is still there changes nothing.
      { situation: 'the mailbox would not say whether the draft started before is still there', status: 502, body: { error: 'Gmail did not answer', putBack: false }, putBack: false },
      { situation: 'a server from before the answer said so', status: 502, body: { error: 'Gmail refused the draft' }, putBack: true },
      { situation: 'the draft was refused before anything changed', status: 400, body: { error: 'A LinkedIn conversation is answered in LinkedIn.' }, putBack: false },
    ])('$situation', async ({ status, body, putBack }) => {
      workerAnswers(status, body);

      const asked = makeADraft('ws-work', 'item-1', { clickId: '0190b6a2-7a6e-7c3d-9f00-000000000001', sourceAccountId: 'sa-work' });

      await expect(asked).rejects.toBeInstanceOf(DraftRefused);
      await expect(asked).rejects.toMatchObject({ message: body.error, status, putBack });
    });
  });

  describe('a draft asked of Claude carries the points the person typed', () => {
    it('sends that Claude is to write it, and the points, in the request', async () => {
      const fetched = vi.fn().mockResolvedValue(new Response(JSON.stringify({ link: 'https://mail.google.com/mail/#drafts' }), { status: 200 }));
      vi.stubGlobal('fetch', fetched);

      const link = await makeADraft('ws-work', 'item-1', {
        clickId: '0190b6a2-7a6e-7c3d-9f00-000000000001',
        sourceAccountId: 'sa-work',
        withClaude: true,
        points: 'only after 8pm',
      });

      expect(link).toBe('https://mail.google.com/mail/#drafts');
      const sent = fetched.mock.calls[0]![0] instanceof Request ? await (fetched.mock.calls[0]![0] as Request).json() : JSON.parse(String(fetched.mock.calls[0]![1].body));
      expect(sent).toMatchObject({ withClaude: true, points: 'only after 8pm', sourceAccountId: 'sa-work' });
    });
  });
});
