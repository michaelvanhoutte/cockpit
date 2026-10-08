import Anthropic from '@anthropic-ai/sdk';
import type { Env } from '../env.js';
import { callThrough, inRealTime, type CallAbout, type Outcome, type Recorder, type RetryPolicy, type Trigger } from '../gateway/attempts.js';
import { providerCallsIn } from '../gateway/record.js';
import { buildCleanUpANote } from './prompts/clean-up-a-note.v11.js';
import { buildChooseAPanel, type ItemToPlace } from './prompts/choose-a-panel.v2.js';
import { readPanelChoice, readProposal, type PanelRead, type ProposalRead } from './note-texts.js';
import type { DecisionHistoryEntry } from '../domain/decision-history.js';
import type { TextCorrectionEntry, WhatStood } from '../domain/text-corrections.js';

export type { NoteTexts, PanelRead, ProposalRead, ReadingCandidate, RoutingCandidate } from './note-texts.js';
export type { ItemToPlace } from './prompts/choose-a-panel.v2.js';

/**
 * The prompt files the two calls are built from, as a record names them -
 * changed with the import above them when a prompt gets a new version.
 */
const CLEAN_UP_A_NOTE = 'clean-up-a-note.v11';
const CHOOSE_A_PANEL = 'choose-a-panel.v2';

/** Whom and what a call is for, as its record names it ("Record every Claude call Cockpit makes", issue 917). */
export interface CallFor {
  accountName: string;
  itemId: string | null;
  /** `null` for a job queued before what started it was carried on the message. */
  triggeredBy: Trigger | null;
}

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
 * call on capture, since both halves are wanted then. The re-read of the rest
 * of an inbox after a filing wants only the Panel, so it asks for only that
 * (`choosePanel`; issue 583) rather than paying for both and throwing one
 * away. A correction re-reads nothing: it shapes later captures only ("Cut
 * what cleaning up a captured note costs", issue 887).
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
   *
   * `callFor` names whom the call is for in its record, never in the prompt.
   */
  cleanUpNote(
    capturedMessage: string,
    panels: readonly { id: string; name: string }[],
    history: readonly DecisionHistoryEntry[],
    recentlyCaptured: readonly string[],
    corrections: readonly TextCorrectionEntry[],
    stood: WhatStood | null,
    callFor: CallFor,
  ): Promise<ProposalRead>;

  /**
   * Which of `panels` an Item belongs on, and nothing else - for a settled
   * filing's refresh of the rest of the inbox, which writes only the Panel
   * (`choose-a-panel.v2`, issue 583). `history` and `recentlyCaptured` are
   * what `cleanUpNote` takes under the same names. Refuses and throws on
   * the same terms as `cleanUpNote`.
   */
  choosePanel(
    item: ItemToPlace,
    panels: readonly { id: string; name: string }[],
    history: readonly DecisionHistoryEntry[],
    recentlyCaptured: readonly string[],
    callFor: CallFor,
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
  return new ClaudeAiService(env.ANTHROPIC_API_KEY, env.ANTHROPIC_WORKSPACE_ID, undefined, providerCallsIn(env));
}

/**
 * How Claude's failures are retried, now that the gateway does it rather than
 * the SDK, so each attempt is a record of its own: once, on what the SDK
 * itself retried - a connection that failed or timed out, and a 408, 409, 429
 * or 5xx unless the API said not to - after what the API asked for, or about
 * half a second.
 */
export const CLAUDE_RETRIES: RetryPolicy = {
  retries: 1,
  outcomeOf(error: unknown): Outcome {
    if (error instanceof Anthropic.APIConnectionTimeoutError) return { outcome: 'timed-out' };
    if (error instanceof Anthropic.APIError && error.status !== undefined) {
      return { outcome: 'error', status: error.status };
    }
    return { outcome: 'error', status: null };
  },
  retryAfter(error: unknown, attempt: number): number | null {
    if (error instanceof Anthropic.APIConnectionError) return backoff(attempt);
    if (!(error instanceof Anthropic.APIError) || error.status === undefined) return null;
    const told = error.headers?.get('x-should-retry');
    if (told === 'false') return null;
    const retryable = told === 'true' || [408, 409, 429].includes(error.status) || error.status >= 500;
    if (!retryable) return null;
    return askedFor(error.headers) ?? backoff(attempt);
  },
};

/** What a failed answer asked to be waited for, in seconds or as a date, where it is a reasonable amount. */
function askedFor(headers: Headers | undefined): number | null {
  const after = headers?.get('retry-after') ?? '';
  const asked = [
    Number.parseFloat(headers?.get('retry-after-ms') ?? ''),
    Number.parseFloat(after) * 1000,
    Date.parse(after) - Date.now(),
  ].find((ms) => !Number.isNaN(ms));
  return asked !== undefined && asked >= 0 && asked < 60_000 ? asked : null;
}

/** The SDK's own default: half a second, doubling per attempt, with up to a quarter off. */
function backoff(attempt: number): number {
  return Math.min(500 * 2 ** (attempt - 1), 8_000) * (1 - Math.random() * 0.25);
}

/** The Claude-backed implementation. Constructed by `aiFor` and nowhere else. */
export class ClaudeAiService implements AiService {
  readonly #client: Anthropic;
  readonly #onUsage: ((model: string, usage: Anthropic.Usage) => void) | undefined;
  readonly #record: Recorder;
  readonly #paidBy: CallAbout['paidBy'];

  /**
   * `onUsage` hears every successful call's model and token counts. Only the
   * contract tier passes one, to say what a prompt costs to run.
   *
   * `record` is handed every attempt's record; `aiFor` passes the one that
   * writes D1, and the contract tier, whose calls are not product usage,
   * passes none.
   */
  constructor(
    apiKey: string,
    workspaceId?: string,
    onUsage?: (model: string, usage: Anthropic.Usage) => void,
    record: Recorder = async () => {},
  ) {
    this.#onUsage = onUsage;
    this.#record = record;
    this.#paidBy = { kind: 'cockpit-anthropic-key', account: workspaceId ?? null, keyEnding: apiKey.slice(-4) };
    this.#client = new Anthropic({
      apiKey,
      // The header is only sent where there is one to send: a key scoped to the
      // organisation rather than to a workspace is refused without it, and a
      // workspace-scoped key needs nothing (see `Env.ANTHROPIC_WORKSPACE_ID`).
      ...(workspaceId ? { defaultHeaders: { 'anthropic-workspace-id': workspaceId } } : {}),
      /**
       * Bounded on purpose. The queue is what retries this job, with a delay a
       * rate limit can actually recover in, and a call left to the default ten
       * minutes would hold a queue consumer open for a note nobody is waiting
       * for.
       *
       * **No retries of the SDK's own**: the gateway makes the one retry that
       * rides out a blip (`CLAUDE_RETRIES`), so that each attempt is recorded.
       */
      timeout: 60_000,
      maxRetries: 0,
    });
  }

  async cleanUpNote(
    capturedMessage: string,
    panels: readonly { id: string; name: string }[],
    history: readonly DecisionHistoryEntry[],
    recentlyCaptured: readonly string[],
    corrections: readonly TextCorrectionEntry[],
    stood: WhatStood | null,
    callFor: CallFor,
  ): Promise<ProposalRead> {
    const prompt = buildCleanUpANote({ panels, history, recentlyCaptured }, corrections, stood);
    const answer = await this.#ask(prompt, capturedMessage, { ...callFor, operation: 'clean-up-a-note', promptVersion: CLEAN_UP_A_NOTE });
    return 'refused' in answer ? { discarded: answer.refused } : readProposal(answer.text, panels.map((panel) => panel.id));
  }

  async choosePanel(
    item: ItemToPlace,
    panels: readonly { id: string; name: string }[],
    history: readonly DecisionHistoryEntry[],
    recentlyCaptured: readonly string[],
    callFor: CallFor,
  ): Promise<PanelRead> {
    const prompt = buildChooseAPanel(item, panels, history, recentlyCaptured);
    const answer = await this.#ask(prompt, prompt.message, { ...callFor, operation: 'choose-a-panel', promptVersion: CHOOSE_A_PANEL });
    return 'refused' in answer ? { discarded: answer.refused } : readPanelChoice(answer.text, panels.map((panel) => panel.id));
  }

  /** One call through the gateway, constrained to the prompt's own schema: its text, or that the model declined. */
  async #ask(
    // `effort` is null for a model that refuses the field (`choose-a-panel.v2`).
    prompt: {
      model: string;
      effort: 'low' | null;
      system: { instructions: string; stable: string; recent: string };
      schema: Record<string, unknown>;
    },
    content: string,
    callFor: CallFor & { operation: string; promptVersion: string },
  ): Promise<{ text: string | undefined } | { refused: string }> {
    const about: CallAbout = { ...callFor, provider: 'anthropic', model: prompt.model, paidBy: this.#paidBy };
    const answer = await callThrough(
      about,
      async () => {
        const answer = await this.#askOnce(prompt, content);
        const usage = answer.usage;
        return {
          value: answer,
          tokens: {
            tokensIn: usage.input_tokens,
            cacheRead: usage.cache_read_input_tokens ?? null,
            cacheWrite: usage.cache_creation_input_tokens ?? null,
            tokensOut: usage.output_tokens,
          },
        };
      },
      CLAUDE_RETRIES,
      inRealTime(this.#record),
    );
    // A refusal is the model declining, not a fault: it reaches here as a
    // successful call with nothing usable in it, which is exactly what a
    // discarded proposal is.
    this.#onUsage?.(prompt.model, answer.usage);
    if (answer.stop_reason === 'refusal') return { refused: 'the model declined the note' };
    return { text: answer.content.find((block) => block.type === 'text')?.text };
  }

  /** One attempt, as the API is asked it. */
  async #askOnce(
    prompt: {
      model: string;
      effort: 'low' | null;
      system: { instructions: string; stable: string; recent: string };
      schema: Record<string, unknown>;
    },
    content: string,
  ): Promise<Anthropic.Message> {
    return this.#client.messages.create({
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
       * Three blocks, the one that changes least first, with a breakpoint
       * after each of the first two: the fixed instructions, then what changes
       * only on a filing or a correction, then what changes with every
       * capture ("Enable prompt caching on the note-cleanup prompt,
       * restructured so the fixed content is a stable prefix", issue 584;
       * "Cut what cleaning up a captured note costs", issue 887). A call reads
       * back at the cache rate whichever of the two prefixes the one before it
       * left standing, for five minutes after the last one. The last block has
       * no breakpoint: a capture changes it every time, and caching it would
       * pay the write premium far more often than it was read back.
       *
       * **The schema is part of what is cached**: a capture's carries this
       * account's panel ids as an `enum`, and a different `output_config.format`
       * invalidates the cache, so a prefix is shared by one account's calls
       * with an unchanged set of panels, never across accounts. The API gives
       * the schema no breakpoint of its own.
       *
       * Neither prompt can send an empty block, which the API refuses: each
       * is left out where it has nothing to say. `choose-a-panel` runs on
       * Haiku 4.5, which caches nothing shorter than 4,096 tokens, so its
       * breakpoints take effect only for an account with a long history.
       */
      system: [
        { type: 'text', text: prompt.system.instructions, cache_control: { type: 'ephemeral' } },
        ...(prompt.system.stable === ''
          ? []
          : [{ type: 'text' as const, text: prompt.system.stable, cache_control: { type: 'ephemeral' as const } }]),
        ...(prompt.system.recent === '' ? [] : [{ type: 'text' as const, text: prompt.system.recent }]),
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
  }
}
