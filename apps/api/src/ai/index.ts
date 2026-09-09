import Anthropic from '@anthropic-ai/sdk';
import type { Env } from '../env.js';
import { CLEAN_UP_A_NOTE } from './prompts/clean-up-a-note.v2.js';
import { readProposal, type ProposalRead } from './note-texts.js';

export type { NoteTexts, ProposalRead, ReadingCandidate } from './note-texts.js';

/**
 * The AI layer behind a project-owned interface (architecture, "AI layer"):
 * takes domain values, returns domain values, so everything around it stays
 * testable with the model faked. Enrichment runs on ingest, in jobs; nothing a
 * person waits for waits on a model call.
 *
 * One method, because one thing asks: a captured note being cleaned up into a
 * title and a message ("Clean up a captured note into a clear title and a
 * fuller message", issue 296), which now also answers with the other ways the
 * note could genuinely be read ("Offer the other readings when a captured note
 * says two things", issue 297) - the same call, not a second ask, so it stays
 * one method rather than becoming two. A routing proposal and plain-English
 * panel rules are still their own issues and land as their own methods, rather
 * than as placeholders here that nothing calls and no test covers.
 */
export interface AiService {
  /**
   * Reads a captured note and proposes what to call it and what it said.
   *
   * Answers a refusal rather than throwing for anything the model itself said:
   * an answer that will not parse or will not validate is a discarded proposal,
   * which the Item survives by keeping the text capture wrote. A call that
   * *fails* - no network, a 5xx, a rate limit - throws, because that is worth
   * retrying and a discarded proposal is not.
   */
  cleanUpNote(capturedMessage: string): Promise<ProposalRead>;
}

/**
 * Whether this environment can enrich anything, and the service if it can.
 *
 * **Null rather than a no-op service.** An environment with no key must not
 * quietly succeed at doing nothing: the caller has to be able to say "there is
 * no key here" in the logs, and `/health` reports the same fact so an
 * environment that will never enrich anything says so out loud rather than
 * being discovered months later (docs/deployment.md, "Secrets and access").
 */
export function aiFor(env: Env): AiService | null {
  if (!env.ANTHROPIC_API_KEY) return null;
  return new ClaudeAiService(env.ANTHROPIC_API_KEY, env.ANTHROPIC_WORKSPACE_ID);
}

/** The Claude-backed implementation. Constructed by `aiFor` and nowhere else. */
export class ClaudeAiService implements AiService {
  readonly #client: Anthropic;

  constructor(apiKey: string, workspaceId?: string) {
    this.#client = new Anthropic({
      apiKey,
      // The header is only sent where there is one to send: a key scoped to the
      // organisation rather than to a workspace is refused without it, and a
      // workspace-scoped key needs nothing (see `Env.ANTHROPIC_WORKSPACE_ID`).
      ...(workspaceId ? { defaultHeaders: { 'anthropic-workspace-id': workspaceId } } : {}),
      /**
       * Bounded on purpose, both of them. The queue is what retries this job,
       * with a delay a rate limit can actually recover in, so the SDK's own
       * retries exist only to ride out a blip - and a call left to the default
       * ten minutes would hold a queue consumer open for a note nobody is
       * waiting for.
       */
      timeout: 60_000,
      maxRetries: 1,
    });
  }

  async cleanUpNote(capturedMessage: string): Promise<ProposalRead> {
    const answer = await this.#client.messages.create({
      model: CLEAN_UP_A_NOTE.model,
      /**
       * Room for the reasoning as well as the answer, since thinking is on by
       * default on this model and is counted here. A note's two texts are a few
       * hundred tokens; the headroom is what stops a long note being cut off
       * mid-JSON, which reaches `readProposal` as an answer that will not parse.
       */
      max_tokens: 8_192,
      system: CLEAN_UP_A_NOTE.system,
      messages: [{ role: 'user', content: capturedMessage }],
      output_config: {
        // Constrained to the prompt's own schema, which is what makes the
        // language a field the answer commits to before it writes anything.
        format: { type: 'json_schema', schema: CLEAN_UP_A_NOTE.schema },
        // **Cast because the installed SDK's `OutputConfig` predates `effort`,
        // not because this is unsupported.** `effort` is a field of
        // `output_config` on the wire and the SDK sends the object as given, so
        // the request is right and only its typing is behind; the contract
        // tests are what would notice if that stopped being true. Drop the cast
        // when the SDK names the field.
        effort: CLEAN_UP_A_NOTE.effort,
      } as Anthropic.OutputConfig,
    });

    // A refusal is the model declining, not a fault: it reaches here as a
    // successful call with nothing usable in it, which is exactly what a
    // discarded proposal is.
    if (answer.stop_reason === 'refusal') return { discarded: 'the model declined the note' };
    const text = answer.content.find((block) => block.type === 'text');
    return readProposal(text?.text);
  }
}
