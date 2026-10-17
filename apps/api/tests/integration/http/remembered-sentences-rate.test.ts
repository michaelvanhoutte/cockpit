import { describe, expect, it } from 'vitest';
import { WORKSPACE_ID, asUser } from '../seed.js';
import { ACCOUNT_WIDE } from '@cockpit/shared';
import { aModelThatReads, captureANote, nextId, offering, postChange } from './note-cleanup.support.js';

/**
 * L2: what holds the two calls that cost something to a rate ("Remember an edit as
 * a sentence you confirm", issue 1163). Its own file because the rate is
 * counted per account in the store's memory, so these cases share an account's
 * minute with nothing else.
 */

aModelThatReads();

const AT = '2026-10-17T10:00:00.000Z';

async function remember(sentence: string, options: { sentenceId?: string; sourceKind?: string } = {}) {
  return postChange('remember_sentence', {
    commandId: nextId(),
    issuedAt: AT,
    workspaceId: ACCOUNT_WIDE,
    sentenceId: options.sentenceId ?? nextId(),
    sentence,
    action: 'reply to a mail',
    sourceKind: options.sourceKind ?? 'gmail',
  });
}

describe('Agents', () => {
  describe('the calls that cost something are held to a rate per account', () => {
    it('refuses Remember after ten in a minute, with words', async () => {
      const statuses: number[] = [];
      for (let at = 0; at < 12; at += 1) statuses.push((await remember(`Sentence number ${at}.`)).status);

      expect(statuses.slice(0, 10)).toEqual(Array(10).fill(200));
      expect(statuses.slice(10)).toEqual([409, 409]);
    });

    it('asks the model for ten offers in a minute and for no more, each later one answering no offer', async () => {
      offering.answer = { sentence: 'Dutch, short.', action: 'reply to a mail', workspace: '' };
      const itemId = await captureANote({ itemId: nextId(), workspaceId: WORKSPACE_ID });
      const runId = nextId();
      const sent = await postChange('send_item_to_claude', {
        commandId: nextId(),
        issuedAt: AT,
        workspaceId: WORKSPACE_ID,
        itemId,
        runId,
        destination: 'cowork',
        folder: '',
        prompt: 'Schrijf kort een antwoord.',
        proposed: { destination: 'cowork', folder: '', prompt: 'Draft a reply.' },
      });
      expect(sent.status).toBe(200);

      const offers: unknown[] = [];
      for (let at = 0; at < 12; at += 1) {
        const res = await asUser(`http://cockpit.test/v1/claude-sends/${runId}/remember-offer`, { method: 'POST' });
        expect(res.status).toBe(200);
        offers.push(((await res.json()) as { offer: unknown }).offer);
      }

      expect(offers.filter((one) => one !== null)).toHaveLength(10);
      expect(offering.asked).toHaveLength(10);
    });
  });
});
