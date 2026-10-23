import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { TRANSCRIPTION_MODEL, base64Of } from '../../src/transcription/index.js';

/**
 * The contract tier: the real Whisper on Workers AI, no fake anywhere
 * (docs/testing-strategy.md, "Third parties"). It costs next to nothing - a few
 * seconds of audio at $0.0005 a minute - so it runs on every contract run, the
 * weekly one included, and when the call it holds changes ("Dictate in Write with Whisper", issue 1041).
 *
 * **What only this tier can prove:** that Workers AI accepts the two formats
 * phones record - WebM/Opus from Chrome on Android and MP4/AAC from Safari on
 * iOS - and writes down what was said in them, in English and in Dutch, saying
 * which language it heard. Every tier below answers with words the test wrote
 * itself.
 *
 * **The samples are synthetic speech, recorded by a browser.** Windows' English
 * and Dutch voices read one sentence each, played into Chromium as its
 * microphone, and recorded by `MediaRecorder` as WebM/Opus (Chromium) and as
 * MP4/AAC (Edge) - the same encoders a phone's browser uses, but not a phone and
 * not a person. A real handset's recording is still to be checked by hand.
 *
 * **Over the model's own address rather than through the binding**, for the
 * reason `read-what-a-note-means.test.ts` gives.
 */

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
const apiToken = process.env.CLOUDFLARE_API_TOKEN ?? '';

interface Heard {
  text: string;
  language: string | undefined;
}

async function transcribe(file: string): Promise<Heard> {
  const audio = new Uint8Array(readFileSync(join(import.meta.dirname, 'recordings', file)));
  const answer = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${TRANSCRIPTION_MODEL}`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ audio: base64Of(audio) }),
    },
  );
  if (!answer.ok) throw new Error(`${TRANSCRIPTION_MODEL} answered ${answer.status} for ${file}: ${await answer.text()}`);
  const read = (await answer.json()) as { result?: { text?: string; transcription_info?: { language?: string } } };
  if (typeof read.result?.text !== 'string') throw new Error(`${TRANSCRIPTION_MODEL} answered with something that is not a transcription`);
  return { text: read.result.text, language: read.result.transcription_info?.language };
}

const SAMPLES = [
  { situation: 'English, recorded as WebM/Opus', file: 'english.webm', language: 'en', words: ['milk', 'dentist'] },
  { situation: 'English, recorded as MP4/AAC', file: 'english.m4a', language: 'en', words: ['milk', 'dentist'] },
  { situation: 'Dutch, recorded as WebM/Opus', file: 'dutch.webm', language: 'nl', words: ['melk', 'tandarts'] },
  { situation: 'Dutch, recorded as MP4/AAC', file: 'dutch.m4a', language: 'nl', words: ['melk', 'tandarts'] },
] as const;

const heard: Record<string, Heard | Error> = {};

beforeAll(async () => {
  if (!accountId || !apiToken) return;
  for (const sample of SAMPLES) {
    heard[sample.file] = await transcribe(sample.file).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
  }
}, 120_000);

describe('Capture', () => {
  it('has an account to transcribe with', () => {
    // Red rather than skipped: a contract run with no credential proved nothing.
    expect(
      accountId && apiToken,
      'set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, or put them in apps/api/.dev.vars',
    ).toBeTruthy();
  });

  describe('a recording a phone makes comes back as the words said in it, in the language they were said in', () => {
    it.each(SAMPLES)('$situation', ({ file, language, words }) => {
      const one = heard[file];
      // Asked first, so a run with no credential is red on every case.
      expect(one, 'nothing was transcribed').toBeDefined();
      if (one instanceof Error) throw one;
      const text = one!.text.toLowerCase();
      for (const word of words) expect(text, `"${one!.text}" lacks "${word}"`).toContain(word);
      expect(one!.language).toBe(language);
    });
  });
});
