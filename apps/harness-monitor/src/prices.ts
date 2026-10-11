import overrides from './price-overrides.json';

/** USD per million tokens, which is also micro-dollars per token. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead?: number;
  /** Cache write with the 5-minute lifetime. */
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  /** What fast mode multiplies every rate by; absent where the model has no fast rate. */
  fastMultiplier?: number;
}

export type PriceList = Record<string, ModelPrice>;

export const LITELLM_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
/** A per-token dollar rate as USD per million, free of floating-point dust. */
const perMillion = (perToken: number) => Number((perToken * 1e6).toPrecision(12));

/**
 * Reads LiteLLM's file into the rates this app prices with: the Anthropic
 * entries that have an input and an output rate. Null when the file is not
 * a price list at all, so a malformed file is a failure and never an empty list.
 */
export function readLiteLlm(file: unknown): PriceList | null {
  if (typeof file !== 'object' || file === null || Array.isArray(file)) return null;
  const list: PriceList = {};
  for (const [name, raw] of Object.entries(file)) {
    const e = raw as Record<string, unknown> | null;
    if (typeof e !== 'object' || e === null || e.litellm_provider !== 'anthropic') continue;
    if (!positive(e.input_cost_per_token) || !positive(e.output_cost_per_token)) continue;
    const price: ModelPrice = { input: perMillion(e.input_cost_per_token), output: perMillion(e.output_cost_per_token) };
    if (positive(e.cache_read_input_token_cost)) price.cacheRead = perMillion(e.cache_read_input_token_cost);
    if (positive(e.cache_creation_input_token_cost)) price.cacheWrite5m = perMillion(e.cache_creation_input_token_cost);
    if (positive(e.cache_creation_input_token_cost_above_1hr)) {
      price.cacheWrite1h = perMillion(e.cache_creation_input_token_cost_above_1hr);
    }
    const fast = (e.provider_specific_entry as { fast?: unknown } | undefined)?.fast;
    if (typeof fast === 'number' && fast > 0) price.fastMultiplier = fast;
    list[name] = price;
  }
  return Object.keys(list).length === 0 ? null : list;
}

/** The repository's own price file: it wins for every model it names. */
export const REPOSITORY_PRICES = (overrides as { models: PriceList }).models;

export function withOverrides(fetched: PriceList, repository: PriceList = REPOSITORY_PRICES): PriceList {
  return { ...fetched, ...repository };
}

/** A model's rates, or undefined: an own key only, so `constructor` is not a model. */
export const priceOf = (list: PriceList, model: string): ModelPrice | undefined =>
  Object.hasOwn(list, model) ? list[model] : undefined;

export interface Tokens {
  input: number;
  output: number;
  cacheCreation: number;
  cacheCreation1h: number;
  cacheRead: number;
}

/**
 * A request's cost in micro-dollars, or null when it cannot be priced: the
 * model is not on the list, or the list has no rate for a kind of token the
 * request used. Null is never 0, but a request with no tokens at all costs
 * nothing whatever its model, so it never waits for a price.
 */
export function costMicros(price: ModelPrice | undefined, speed: string, t: Tokens): number | null {
  if (t.input + t.output + t.cacheCreation + t.cacheRead === 0) return 0;
  if (!price) return null;
  const cacheWrite5m = t.cacheCreation - t.cacheCreation1h;
  const parts: [number, number | undefined][] = [
    [t.input, price.input],
    [t.output, price.output],
    [t.cacheRead, price.cacheRead],
    [cacheWrite5m, price.cacheWrite5m],
    [t.cacheCreation1h, price.cacheWrite1h],
  ];
  let total = 0;
  for (const [tokens, rate] of parts) {
    if (tokens === 0) continue;
    if (rate === undefined) return null;
    total += tokens * rate;
  }
  return Math.round(total * (speed === 'fast' ? (price.fastMultiplier ?? 1) : 1));
}
