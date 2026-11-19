import { describe, expect, it } from 'vitest';
import { GraphWorld, itemOf, signedInHost } from './outlook-world.js';
import { withoutPhoneSignature } from '../../src/messages.js';
import shared from '../../../phone-signatures.json';

/**
 * L1, against a fake host and Microsoft Graph faked at the network: the lines
 * a phone's mail app adds never reach an email Item's description or the
 * clean-up ("Clean-up reads an email's subject, and a phone signature is
 * removed first", issue 1836). The phrases are the list the Gmail connector's
 * tests run too (`packages/connectors/phone-signatures.json`), so the two
 * copies of the rule cannot drift.
 */

/** What the connector files for one flagged message with this text. */
async function filedFor(subject: string, text: string) {
  const world = new GraphWorld();
  world.arrives('m-1', { flag: 'flagged', subject, text });
  const host = signedInHost();
  await world.connector().sync(host);
  return host.filed.get(itemOf('m-1'))!;
}

describe('Capture', () => {
  describe("a mail app's own signature never reaches an email Item's description or the clean-up", () => {
    it.each(shared.removed.map((line) => ({ situation: line.trim(), line })))(
      'leaves nothing of "$situation" and files the subject as all there is',
      async ({ line }) => {
        const filed = await filedFor('conselit email', line);

        expect(filed.capturedMessage).toBe('conselit email');
        expect(filed.title).toBe('conselit email');
        expect(filed.titleIsAll).toBe(true);
      },
    );

    it.each(shared.removed.map((line) => ({ situation: line.trim(), line })))(
      'keeps your words alone when "$situation" comes after them',
      async ({ line }) => {
        const filed = await filedFor('Chase the invoice', `Please pay by Friday.\n\n${line}`);

        expect(filed.capturedMessage).toBe('Please pay by Friday.');
        expect(filed.titleIsAll).toBeUndefined();
      },
    );

    it.each(shared.keptInASentence.map((sentence) => ({ situation: sentence, sentence })))(
      'keeps a sentence that only mentions it: $situation',
      async ({ sentence }) => {
        const filed = await filedFor('Typos', sentence);

        expect(filed.capturedMessage).toBe(sentence);
        expect(filed.titleIsAll).toBeUndefined();
      },
    );

    it('keeps the text of a forwarded email below the signature', async () => {
      const forward = 'Begin forwarded message:\nFrom: Pieter\nCan you check the figures?';
      const filed = await filedFor('Fwd: figures', `Verzonden vanaf Outlook voor Android <https://aka.ms/AAb9ysg>\n\n${forward}`);

      expect(filed.capturedMessage).toBe(forward);
    });

    it('removes the link a signature leaves on a line of its own', async () => {
      const filed = await filedFor('Idea', 'Get Outlook for Android\nhttps://aka.ms/AAb9ysg');

      expect(filed.capturedMessage).toBe('Idea');
      expect(filed.titleIsAll).toBe(true);
    });

    it('files "(no subject)" as the title of a signature-only email with no subject either', async () => {
      const filed = await filedFor('', 'Sent from my iPhone');

      expect(filed.title).toBe('(no subject)');
      expect(filed.capturedMessage).toBe('(no subject)');
      expect(filed.titleIsAll).toBe(true);
    });

    it('removes a signature that falls past the description limit before the text is cut', async () => {
      const words = 'w'.repeat(59_990);
      const filed = await filedFor('Long one', `${words}\n\nSent from my iPhone`);

      expect(filed.capturedMessage).toBe(words);
    });

    it('leaves a text with blank-line runs and no signature exactly as it is', async () => {
      const text = 'First paragraph.\n\n\n\nSecond paragraph.';

      expect((await filedFor('Spacing', text)).capturedMessage).toBe(text);
    });

    it.each([' ', '\u00a0'])('keeps a long line that only starts like a signature, and answers at once (%j filler)', async (filler) => {
      const line = `Sent from my iPhone${filler.repeat(10_000)}x`;
      const started = performance.now();

      const kept = withoutPhoneSignature(line);

      expect(performance.now() - started).toBeLessThan(100);
      expect(kept).toBe(line);
      expect((await filedFor('Slow?', line)).capturedMessage).toBe(line);
    });
  });
});
