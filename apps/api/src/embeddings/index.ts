import { z } from 'zod';
import type { Env } from '../env.js';

/**
 * Reading what a note *means*, behind a project-owned interface - the same
 * shape the Claude layer next door has (`ai/index.ts`, "The AI layer"), and for
 * the same reason: it takes a text and answers a domain value, so everything
 * around it stays testable with the model replaced.
 *
 * **A binding rather than a key.** Workers AI is reached through
 * `env.AI`, so no environment needs a new secret put in it and no new vendor is
 * involved ("Flag a captured note that says what another one already said",
 * issue 407). Anthropic has no embedding model, which is why this is a second
 * service rather than a second method on the one above.
 */
export interface EmbeddingService {
  /**
   * What one text means, as a vector.
   *
   * Throws rather than answering a refusal, unlike `cleanUpNote`: there is no
   * such thing as the model declining a piece of text here, so everything that
   * can go wrong is a call that failed - which is worth retrying, and is what
   * the queue retries (`jobs/enrichment.ts`).
   */
  readMeaning(text: string): Promise<number[]>;
}

/**
 * The model, and the reason it is this one: `bge-m3` is multilingual, and the
 * notes this reads are Dutch and English - often in the same note. A model
 * trained on English alone would read a Dutch note and its English twin as two
 * different things, which is the case this feature exists for.
 *
 * **Stored beside every reading it produces** (`itemMeanings.model`,
 * accounts/schema.ts), so readings from two different models are never compared
 * with each other - a vector from one model is not in the same space as a
 * vector from another, and comparing them would be arithmetic on noise.
 */
export const EMBEDDING_MODEL = '@cf/baai/bge-m3';

/**
 * Whether this environment can read meaning at all, and so whether there is any
 * point queueing the work ("Flag a captured note that says what another one
 * already said", issue 407).
 *
 * **Asked of the AI binding, and of nothing else.** `enqueueCleanUp` beside it
 * returns early without a Claude key, and an environment that cannot clean a
 * note up must still be able to flag a duplicate - the two are separate
 * capabilities with separate configuration, and folding them together is the
 * mistake this predicate exists to make impossible. `/health` reports the same
 * fact (`accounts/probe.ts`).
 */
export function canReadMeaning(env: Env): boolean {
  return Boolean(env.AI) || env.EMBEDDINGS_STAND_IN === 'true';
}

/** The service this environment can read meaning with, or null where it cannot. */
export function embeddingsFor(env: Env): EmbeddingService | null {
  // Asked first, so a stack that has deliberately been given a stand-in uses
  // it even where a binding is also present - the same precedence `OIDC_ISSUER`
  // takes over Google (`auth/issuer.ts`).
  if (env.EMBEDDINGS_STAND_IN === 'true') return new StandInEmbeddingService();
  if (env.AI) return new WorkersAiEmbeddingService(env.AI);
  return null;
}

/**
 * What Workers AI answers a text-embedding call with. Parsed rather than cast,
 * for the reason a queued job's body is: it comes from outside this program,
 * and a model whose answer has changed shape must fail loudly here rather than
 * write a vector of `undefined`s into somebody's account.
 */
const embeddingAnswerSchema = z.object({
  data: z.array(z.array(z.number()).min(1)).min(1),
});

/** The Workers AI implementation. Constructed by `embeddingsFor` and nowhere else. */
export class WorkersAiEmbeddingService implements EmbeddingService {
  readonly #ai: Env['AI'];

  constructor(ai: NonNullable<Env['AI']>) {
    this.#ai = ai;
  }

  async readMeaning(text: string): Promise<number[]> {
    const answer = await (
      this.#ai as unknown as { run: (model: string, input: unknown) => Promise<unknown> }
    ).run(EMBEDDING_MODEL, { text: [text] });
    const read = embeddingAnswerSchema.safeParse(answer);
    if (!read.success) {
      throw new Error(`${EMBEDDING_MODEL} answered with something that is not a reading`);
    }
    return read.data.data[0]!;
  }
}

/**
 * How long a text may be before it is cut, in characters.
 *
 * `bge-m3` takes 8192 tokens, and a note that long is a note whose first
 * paragraphs are what it is about - so the tail is dropped rather than the
 * whole note refused ("A very long note | read", issue 407). Characters rather
 * than tokens because nothing here tokenizes, and four characters to a token is
 * the ratio that keeps a Dutch or English note comfortably inside the window.
 */
export const LONGEST_TEXT_READ = 8_000;

/** The text as the model will see it: whole, unless it is longer than the window. */
export function asFarAsItReads(text: string): string {
  return text.length <= LONGEST_TEXT_READ ? text : text.slice(0, LONGEST_TEXT_READ);
}

/**
 * A stand-in for the model, for a stack that has no Cloudflare account to reach
 * one with: local development on a machine that has never run `wrangler login`,
 * and the browser suite, which must answer the same way on every run and on a
 * CI runner with no credentials at all (scripts/e2e-stack.mjs).
 *
 * **It reads words, not meaning, and is never what a deployed environment
 * uses.** Two notes saying the same thing in different words score low here and
 * high against the real model, so nothing about *what* gets flagged is provable
 * against this - that is the contract tier's question
 * (tests/contract/read-what-a-note-means.test.ts). What it is for is everything
 * around the reading: that a capture queues one, that a pair is written and
 * drawn, and that a person can walk from a flagged row to the note it repeats.
 *
 * The same trade `OIDC_ISSUER` records for signing in: a third party the two
 * local stacks cannot reach, stood in for so that they run the same flow a
 * deployment runs.
 */
export class StandInEmbeddingService implements EmbeddingService {
  async readMeaning(text: string): Promise<number[]> {
    return standInReading(text);
  }
}

/** How many numbers a stand-in reading has. Small, and nothing depends on the number. */
const STAND_IN_WIDTH = 64;

/**
 * A text's words, counted into fixed buckets - so the same words give the same
 * numbers, and two texts sharing most of their words point in nearly the same
 * direction.
 */
export function standInReading(text: string): number[] {
  const reading = new Array<number>(STAND_IN_WIDTH).fill(0);
  for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!word) continue;
    let hash = 2_166_136_261;
    for (let at = 0; at < word.length; at += 1) {
      hash ^= word.charCodeAt(at);
      hash = Math.imul(hash, 16_777_619);
    }
    const at = Math.abs(hash) % STAND_IN_WIDTH;
    reading[at] = reading[at]! + 1;
  }
  // Never all zeroes: a text of nothing but punctuation would otherwise point
  // nowhere, and `howAlike` answers 0 for that - which reads as "unlike
  // everything" rather than as "there was nothing to read".
  reading[0] = reading[0]! + 1;
  return reading;
}
