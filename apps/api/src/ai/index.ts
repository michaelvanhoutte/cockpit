import Anthropic from '@anthropic-ai/sdk';
import type { Env } from '../env.js';
import { buildCleanUpANote } from './prompts/clean-up-a-note.v9.js';
import { buildChooseAPanel, type ItemToPlace } from './prompts/choose-a-panel.v1.js';
import { readPanelChoice, readProposal, type PanelRead, type ProposalRead } from './note-texts.js';
import type { DecisionHistoryEntry } from '../domain/decision-history.js';
import type { TextCorrectionEntry, WhatStood } from '../domain/text-corrections.js';

export type { NoteTexts, PanelRead, ProposalRead, ReadingCandidate, RoutingCandidate } from './note-texts.js';
export type { ItemToPlace } from './prompts/choose-a-panel.v1.js';

/**
 * The AI layer behind a project-owned interface (architecture, "AI layer"):
 * takes domain values, returns domain values, so everything around it stays
 * testable with the model faked. Enrichment runs on ingest, in jobs; nothing a
 * person waits for waits on a model call.
 *
 * **No method that nothing reads back.** `summarizeFilingPatterns` wrote a
 * paragraph nothing ever read ("Drop the nightly filing summary, keep the
 * sentence you wrote", issue 392). What learning there is happens inside the
 * calls below, from the decision history and corrections they already read.
 *
 * `cleanUpNote` is a captured note being cleaned up into a title and a message
 * ("Clean up a captured note into a clear title and a fuller message", issue
 * 296), which also answers with the other ways the note could genuinely be
 * read ("Offer the other readings when a captured note says two things",
 * issue 297) and which Panel it belongs on, where one clearly fits ("Propose
 * where a captured note belongs, without filing it there", issue 298) - one
 * call on capture, since both halves are wanted then. The two re-reads of the
 * rest of an inbox each want only one half, so each asks for only that half
 * (`rewriteTexts`, `choosePanel`; issue 583) rather than paying for both and
 * throwing one away.
 */
export interface AiService {
  /**
   * Reads a captured note and proposes what to call it, what it said, and
   * which of the given Panels it belongs on.
   *
   * `panels` is the account's own, read fresh for this call - what the answer's
   * `panel.panelId` is allowed to be, structurally, is that list and nothing
   * else (`buildCleanUpANote`'s schema `enum`).
   *
   * `history` is the most recent 50 settled decisions for this note's
   * workspace whose chosen Panel still exists, oldest first, and
   * `recentlyCaptured` is what else has been captured there lately and not
   * yet filed - the two inputs that let a proposal learn from where notes
   * actually get filed ("Learn where notes belong from where you actually
   * file them", issue 299; "Cap the routing prompt to the last 50 decisions
   * on panels that still exist, and drop the correction override", issue
   * 450).
   *
   * `corrections` is every text this account corrected in the last 30 days,
   * oldest first, and `stood` is how many other proposals simply stood in
   * that same window, or `null` where fewer than 3 did - the evidence that
   * lets a proposal learn this person's own vocabulary rather than general
   * style ("Learn how you write from the titles you correct", issue 394;
   * "Cap the text-learning prompt to the last 30 days, and drop rules and
   * pinned examples as inputs", issue 451; `docs/text-learning.md`). Per
   * account, unlike the routing inputs above.
   *
   * **No `rules` or `pinnedExamples` parameter.** Both were read into this
   * prompt once; issue 451 stopped that, in favour of learning purely from
   * what this account actually does. Both are still stored, and nothing
   * reads or writes them.
   *
   * Answers a refusal rather than throwing for anything the model itself said:
   * an answer that will not parse or will not validate is a discarded proposal,
   * which the Item survives by keeping the text capture wrote. A call that
   * *fails* - no network, a 5xx, a rate limit - throws, because that is worth
   * retrying and a discarded proposal is not.
   */
  cleanUpNote(
    capturedMessage: string,
    panels: readonly { id: string; name: string }[],
    history: readonly DecisionHistoryEntry[],
    recentlyCaptured: readonly string[],
    corrections: readonly TextCorrectionEntry[],
    stood: WhatStood | null,
  ): Promise<ProposalRead>;

  /**
   * `cleanUpNote` with nothing asked about Panels - the same prompt, the same
   * model, and its `panel` always `null` - for a correction's re-read of the
   * rest of the inbox, which writes only the texts ("Use a cheaper model for
   * panel-only re-proposal", issue 583).
   */
  rewriteTexts(
    capturedMessage: string,
    corrections: readonly TextCorrectionEntry[],
    stood: WhatStood | null,
  ): Promise<ProposalRead>;

  /**
   * Which of `panels` an Item belongs on, and nothing else - for a settled
   * filing's refresh of the rest of the inbox, which writes only the Panel
   * (`choose-a-panel.v1`, issue 583). `history` and `recentlyCaptured` are
   * what `cleanUpNote` takes under the same names. Refuses and throws on
   * the same terms as `cleanUpNote`.
   */
  choosePanel(
    item: ItemToPlace,
    panels: readonly { id: string; name: string }[],
    history: readonly DecisionHistoryEntry[],
    recentlyCaptured: readonly string[],
  ): Promise<PanelRead>;
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
  readonly #onUsage: ((model: string, usage: Anthropic.Usage) => void) | undefined;

  /**
   * `onUsage` hears every successful call's model and token counts. Only the
   * contract tier passes one, to say what a prompt costs to run.
   */
  constructor(apiKey: string, workspaceId?: string, onUsage?: (model: string, usage: Anthropic.Usage) => void) {
    this.#onUsage = onUsage;
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

  async cleanUpNote(
    capturedMessage: string,
    panels: readonly { id: string; name: string }[],
    history: readonly DecisionHistoryEntry[],
    recentlyCaptured: readonly string[],
    corrections: readonly TextCorrectionEntry[],
    stood: WhatStood | null,
  ): Promise<ProposalRead> {
    const prompt = buildCleanUpANote({ panels, history, recentlyCaptured }, corrections, stood);
    const answer = await this.#ask(prompt, capturedMessage);
    return 'refused' in answer ? { discarded: answer.refused } : readProposal(answer.text, panels.map((panel) => panel.id));
  }

  async rewriteTexts(
    capturedMessage: string,
    corrections: readonly TextCorrectionEntry[],
    stood: WhatStood | null,
  ): Promise<ProposalRead> {
    const prompt = buildCleanUpANote(null, corrections, stood);
    const answer = await this.#ask(prompt, capturedMessage);
    // No Panel was offered, so none can be read back.
    return 'refused' in answer ? { discarded: answer.refused } : readProposal(answer.text, []);
  }

  async choosePanel(
    item: ItemToPlace,
    panels: readonly { id: string; name: string }[],
    history: readonly DecisionHistoryEntry[],
    recentlyCaptured: readonly string[],
  ): Promise<PanelRead> {
    const prompt = buildChooseAPanel(item, panels, history, recentlyCaptured);
    const answer = await this.#ask(prompt, prompt.message);
    return 'refused' in answer ? { discarded: answer.refused } : readPanelChoice(answer.text, panels.map((panel) => panel.id));
  }

  /** One call, constrained to the prompt's own schema: its text, or that the model declined. */
  async #ask(
    // `effort` is null for a model that refuses the field (`choose-a-panel.v1`).
    prompt: {
      model: string;
      effort: 'low' | null;
      system: string | { instructions: string; context: string };
      schema: Record<string, unknown>;
    },
    content: string,
  ): Promise<{ text: string | undefined } | { refused: string }> {
    const answer = await this.#client.messages.create({
      model: prompt.model,
      /**
       * Room for the reasoning as well as the answer, since thinking is on by
       * default on the texts' model and is counted here. A note's two texts are
       * a few hundred tokens; the headroom is what stops a long note being cut
       * off mid-JSON, which reaches `readProposal` as an answer that will not
       * parse.
       */
      max_tokens: 8_192,
      /**
       * `clean-up-a-note`'s fixed half carries the breakpoint, so every call
       * with the same schema reads it back at the cache rate for five minutes
       * after the last one ("Enable prompt caching on the note-cleanup
       * prompt, restructured so the fixed content is a stable prefix", issue
       * 584). **The schema is part of what is cached**: a capture's carries
       * this account's panel ids as an `enum`, and a different
       * `output_config.format` invalidates the cache, so that prefix is shared
       * by one account's captures with an unchanged set of panels, never
       * across accounts; a texts-only re-read has no `enum`, so its prefix is
       * shared more widely. The API gives the schema no breakpoint of its own.
       * Nothing after the marker is cached: `context` changes with every note
       * filed or captured, and a second breakpoint on it would pay the write
       * premium far more often than it was read back.
       *
       * `choose-a-panel` goes as the one string it is, uncached: it runs on
       * Haiku 4.5, which caches nothing shorter than 4,096 tokens, and its
       * fixed part is a fraction of that.
       */
      system:
        typeof prompt.system === 'string'
          ? prompt.system
          : [
              { type: 'text', text: prompt.system.instructions, cache_control: { type: 'ephemeral' } },
              // Left out rather than sent empty, which the API refuses.
              ...(prompt.system.context === '' ? [] : [{ type: 'text' as const, text: prompt.system.context }]),
            ],
      messages: [{ role: 'user', content }],
      output_config: {
        // Constrained to the prompt's own schema, which is what makes the
        // language a field the answer commits to before it writes anything -
        // and what makes a proposed panel id structurally one of the ids this
        // very call offered.
        format: { type: 'json_schema', schema: prompt.schema },
        // **Cast because the installed SDK's `OutputConfig` predates `effort`,
        // not because this is unsupported.** `effort` is a field of
        // `output_config` on the wire and the SDK sends the object as given, so
        // the request is right and only its typing is behind; the contract
        // tests are what would notice if that stopped being true. Drop the cast
        // when the SDK names the field.
        ...(prompt.effort ? { effort: prompt.effort } : {}),
      } as Anthropic.OutputConfig,
    });

    // A refusal is the model declining, not a fault: it reaches here as a
    // successful call with nothing usable in it, which is exactly what a
    // discarded proposal is.
    this.#onUsage?.(prompt.model, answer.usage);
    if (answer.stop_reason === 'refusal') return { refused: 'the model declined the note' };
    return { text: answer.content.find((block) => block.type === 'text')?.text };
  }
}
