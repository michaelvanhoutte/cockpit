import { beforeAll, describe, expect, it } from 'vitest';
import { EMBEDDING_MODEL } from '../../src/embeddings/index.js';
import { SAYS_THE_SAME_THING, howAlike } from '../../src/domain/duplicates.js';

/**
 * The contract tier: the real Workers AI model, no fake anywhere
 * (docs/testing-strategy.md, "Third parties"). **Scheduled, never on a pull
 * request**, for the reason the Claude one beside it is: a run costs money and
 * takes as long as the service does.
 *
 * What only this tier can prove: that the model actually reads two notes saying
 * the same thing in different words as saying the same thing, and an unrelated
 * note as unrelated - the property the whole feature rests on ("Flag a captured
 * note that says what another one already said", issue 407). Every tier below
 * answers with readings the test wrote itself, so none of them can tell a
 * working model from a broken one.
 *
 * **Over the same model by its own address rather than through the binding.**
 * A binding needs a Worker, and this tier deliberately has none; what is under
 * test is the model's behaviour, which is the same model either way, and the
 * binding's own plumbing is exercised by every tier that runs the Worker.
 *
 * A failure here is the model having drifted from what the cut-off was placed
 * against, and fixing it is priority work rather than something to re-run.
 */

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
const apiToken = process.env.CLOUDFLARE_API_TOKEN ?? '';

/** One note, read for what it means. */
async function readMeaning(text: string): Promise<number[]> {
  const answer = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${EMBEDDING_MODEL}`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: [text] }),
    },
  );
  if (!answer.ok) throw new Error(`${EMBEDDING_MODEL} answered ${answer.status}`);
  const read = (await answer.json()) as { result?: { data?: number[][] } };
  const reading = read.result?.data?.[0];
  if (!reading) throw new Error(`${EMBEDDING_MODEL} answered with something that is not a reading`);
  return reading;
}

/**
 * One note, and four others: itself again, itself reworded, itself in Dutch,
 * and something else entirely. None of them is a note this repository uses
 * anywhere else, so nothing here can pass by having been seen before.
 */
const A_NOTE =
  'Ask Novy about the part 11 audit trail\n\nCheck with Novy whether the Part 11 audit trail covers the validation protocol.';
const OTHERS = {
  'the same words twice': A_NOTE,
  'the same meaning in different words':
    'Chase the audit-trail question with Novy\n\nFind out from Novy if the validation protocol is covered by the Part 11 audit trail.',
  'the same meaning in Dutch':
    'Novy vragen over het part 11 audit trail\n\nNagaan bij Novy of het validatieprotocol onder het Part 11 audit trail valt.',
  'an unrelated note': 'Buy milk and bread\n\nStop at the shop on the way home for milk and bread.',
} as const;

const howAlikeThey: Record<string, number> = {};

beforeAll(async () => {
  if (!accountId || !apiToken) return;
  const reading = await readMeaning(A_NOTE);
  for (const [situation, other] of Object.entries(OTHERS)) {
    howAlikeThey[situation] = howAlike(reading, await readMeaning(other));
  }
}, 120_000);

describe('Triage', () => {
  it('has an account to read a note with', () => {
    // Red rather than skipped: a contract run with no credential is a run that
    // proved nothing, and a skipped tier reads green from the outside.
    expect(
      accountId && apiToken,
      'set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, or put them in apps/api/.dev.vars',
    ).toBeTruthy();
  });

  describe('an item is a possible duplicate of another when the two say the same thing, however differently they word it', () => {
    it.each([
      { situation: 'the same words twice', marked: true },
      { situation: 'the same meaning in different words', marked: true },
      { situation: 'the same meaning in Dutch', marked: true },
      { situation: 'an unrelated note', marked: false },
    ])('$situation', ({ situation, marked }) => {
      expect(howAlikeThey[situation]! >= SAYS_THE_SAME_THING).toBe(marked);
    });

    /**
     * The property the cut-off is placed on, said without naming a number: a
     * note reworded has to read as closer to the original than an unrelated one
     * does, by a margin no cut-off could sit outside by accident. A model that
     * answered every pair 0.99 would pass the table above and fail here.
     */
    it('reads a note reworded as far closer than an unrelated one', () => {
      expect(howAlikeThey['the same meaning in different words']!).toBeGreaterThan(
        howAlikeThey['an unrelated note']! + 0.2,
      );
      expect(howAlikeThey['the same meaning in Dutch']!).toBeGreaterThan(
        howAlikeThey['an unrelated note']! + 0.2,
      );
    });
  });
});
