import { z } from 'zod';
import type { Env } from '../env.js';
import { callThrough, inRealTime, NEVER_RETRIED, type CallAbout, type Outcome, type Recorder } from '../gateway/attempts.js';
import { recorderFor } from '../gateway/send.js';

/**
 * Turning a recording into the words said in it, behind a project-owned
 * interface - the same shape `embeddings/index.ts` has, for the same reason:
 * everything around the call stays testable with the model replaced ("Dictate in
 * Write with Whisper", issue 1041, under "Dictate in Capture with Whisper
 * instead of the browser's speech engine", issue 1037).
 *
 * **The audio is held in memory for the call and goes nowhere else**: not to D1,
 * not to R2, not to a queue, and not into the record the gateway writes, which
 * has no column that could hold it. A binding rather than a key, like the
 * embeddings: `env.AI`, billed to Cockpit's Cloudflare account.
 */
export interface Transcriber {
  /**
   * The words said in `audio`, as the model wrote them: Dutch or English, which
   * it tells apart itself. Throws where the call failed, and answers an empty
   * string for a recording with no speech in it.
   */
  transcribe(audio: Uint8Array, forAccount: string): Promise<string>;
}

/** Whisper large-v3-turbo: $0.0005 an audio minute, and it detects the language itself. */
export const TRANSCRIPTION_MODEL = '@cf/openai/whisper-large-v3-turbo';

/**
 * Whether this environment can transcribe at all, and so whether the page
 * should draw a mic. Asked of the binding and the stand-in alone, and reported
 * by `/health` beside `embeddings` (`accounts/probe.ts`).
 */
export function canTranscribe(env: Env): boolean {
  return Boolean(env.AI) || env.TRANSCRIPTION_STAND_IN === 'true';
}

/** The transcriber this environment has, or null where it has none. */
export function transcriberFor(env: Env): Transcriber | null {
  // The stand-in first, so a stack deliberately given one uses it even where a
  // binding is also present - the precedence `embeddingsFor` takes.
  if (env.TRANSCRIPTION_STAND_IN === 'true') return new StandInTranscriber();
  if (env.AI) return new WhisperTranscriber(env.AI, recorderFor(env));
  return null;
}

/**
 * What Workers AI answers with. Parsed rather than cast: it comes from outside
 * this program, and a model whose answer has changed shape must fail loudly
 * here rather than put `undefined` into somebody's note.
 */
const whisperAnswerSchema = z.object({ text: z.string() });

function workersAiOutcome(error: unknown): Outcome {
  return error instanceof Error && error.name === 'TimeoutError' ? { outcome: 'timed-out' } : { outcome: 'error', status: null };
}

/** Base64 of bytes, in slices, because `String.fromCharCode(...bytes)` overflows the stack on a recording. */
export function base64Of(bytes: Uint8Array): string {
  let binary = '';
  const slice = 0x8000;
  for (let at = 0; at < bytes.length; at += slice) {
    binary += String.fromCharCode(...bytes.subarray(at, at + slice));
  }
  return btoa(binary);
}

/** The Workers AI implementation. Constructed by `transcriberFor` and nowhere else. */
export class WhisperTranscriber implements Transcriber {
  readonly #ai: NonNullable<Env['AI']>;
  readonly #record: Recorder;

  constructor(ai: NonNullable<Env['AI']>, record: Recorder) {
    this.#ai = ai;
    this.#record = record;
  }

  /** One call through the gateway, never repeated here: a retry is the person tapping again. */
  async transcribe(audio: Uint8Array, forAccount: string): Promise<string> {
    const about: CallAbout = {
      operation: 'transcribe-a-recording',
      promptVersion: null,
      triggeredBy: 'dictated-in-app',
      accountName: forAccount,
      itemId: null,
      provider: 'cloudflare',
      model: TRANSCRIPTION_MODEL,
      paidBy: { kind: 'cloudflare-workers-ai', account: null, keyEnding: null },
    };
    return callThrough(
      about,
      async () => {
        const answer = await this.#ai.run(TRANSCRIPTION_MODEL, { audio: base64Of(audio) });
        const read = whisperAnswerSchema.safeParse(answer);
        if (!read.success) throw new Error(`${TRANSCRIPTION_MODEL} answered with something that is not a transcription`);
        return { value: read.data.text.trim(), tokens: null };
      },
      { ...NEVER_RETRIED, outcomeOf: workersAiOutcome },
      inRealTime(this.#record),
    );
  }
}

/**
 * What the stand-in says, whatever it was given. Fixed, so a walk can assert on
 * it, and plainly not speech so nobody reads it as the model's.
 */
export const STAND_IN_WORDS = 'This is the stand-in transcription.';

/**
 * For a stack that has no Cloudflare account to reach Whisper with: local
 * development and the browser suite (scripts/dev.mjs, scripts/e2e-stack.mjs). It
 * hears nothing, so nothing about *what* Whisper makes of a voice is provable
 * against it - that is the contract tier's question
 * (tests/contract/transcribe-a-recording.test.ts). Not a paid call, so recorded
 * nowhere.
 */
export class StandInTranscriber implements Transcriber {
  async transcribe(): Promise<string> {
    return STAND_IN_WORDS;
  }
}
