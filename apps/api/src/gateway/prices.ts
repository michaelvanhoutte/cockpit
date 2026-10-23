import type { AttemptRecord } from './attempts.js';

/**
 * What a call costs ("Price every Claude call production records, and name its
 * environment", issue 1457): the price list production prices each record from
 * as it writes it. A record keeps the cost it was written with, so a price
 * changed here prices only what is recorded after it is deployed.
 */

/** US dollars per million tokens, as Anthropic publishes them. */
export interface Price {
  input: number;
  /** A cache read: a tenth of the input rate. */
  cacheRead: number;
  /** A five-minute cache write: 1.25 times the input rate. Nothing writes the one-hour cache, billed at twice. */
  cacheWrite: number;
  output: number;
  /** The most prompt tokens - input, cache read and cache write - these rates hold for; above it there is no price. */
  upToPromptTokens?: number;
}

/** Rates at the input and output a model is published at, with the cache rates derived from the input. */
function rates(input: number, output: number, upToPromptTokens?: number): Price {
  return { input, cacheRead: input / 10, cacheWrite: input * 1.25, output, ...(upToPromptTokens ? { upToPromptTokens } : {}) };
}

/**
 * What Cockpit's Anthropic key pays, for each model a prompt under
 * `src/ai/prompts/` names (Anthropic's published API rates, October 2026). A
 * prompt moved to a model missing here records no cost until it is added.
 */
export const ANTHROPIC_PRICES: Readonly<Record<string, Price>> = Object.freeze({
  'claude-sonnet-5-5': rates(2, 10),
  // Published for prompts of up to 100,000 tokens; a longer one is billed at a rate this list does not hold.
  'claude-haiku-5-5': rates(0.1, 0.5, 100_000),
  'claude-haiku-4-5': rates(1, 5),
});

/** Millionths of a dollar per million tokens, so a cost is summed in whole numbers and rounded once. */
const exact = (dollarsPerMillion: number) => Math.round(dollarsPerMillion * 1_000_000);

/**
 * What one attempt cost in US dollars, or `null` where that is not known: a
 * provider or a payer not billed by the token (Workers AI, a routine on the
 * person's own plan), a model with no price, or an attempt that reported no
 * tokens, as a failed one does. Never 0 for "not known".
 *
 * A cache count the provider left out is a cache it did not use.
 */
export function costOf(
  record: Pick<AttemptRecord, 'model' | 'paidBy' | 'tokensIn' | 'cacheRead' | 'cacheWrite' | 'tokensOut'>,
  prices: Readonly<Record<string, Price>> = ANTHROPIC_PRICES,
): number | null {
  if (record.paidBy.kind !== 'cockpit-anthropic-key') return null;
  const price = Object.hasOwn(prices, record.model) ? prices[record.model] : undefined;
  if (!price || record.tokensIn === null || record.tokensOut === null) return null;
  const cacheRead = record.cacheRead ?? 0;
  const cacheWrite = record.cacheWrite ?? 0;
  if (price.upToPromptTokens !== undefined && record.tokensIn + cacheRead + cacheWrite > price.upToPromptTokens) return null;
  const picodollars =
    record.tokensIn * exact(price.input) +
    cacheRead * exact(price.cacheRead) +
    cacheWrite * exact(price.cacheWrite) +
    record.tokensOut * exact(price.output);
  return picodollars / 1e12;
}
