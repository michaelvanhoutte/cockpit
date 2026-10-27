import { belgianDay } from './belgium';

/** The nine things a request can be spent on, as the slugs stored, in pipeline order. */
export const CATEGORIES = [
  'unphased',
  'outside-process',
  'scoping-planning',
  'building',
  'local-code-review',
  'local-security-review',
  'after-push',
  'ci-reviews',
  'process-review',
] as const;
export type Category = (typeof CATEGORIES)[number];

/**
 * The phases of work done inside the process. A request in one of them from a branch no pull request names is
 * credited to the pull request its session went on to build; Outside the process, Unphased and CI reviews are not.
 */
export const CREDITED_PHASES = ['scoping-planning', 'building', 'local-code-review', 'local-security-review', 'after-push', 'process-review'] as const satisfies readonly Category[];

/**
 * No phase marks existed before this UTC day, so a Building request dated earlier
 * was never really Building. Stored rows are not rewritten: every read and every
 * rebuild of the totals applies this rule. The cut-off is the instant it always
 * was, 00:00 UTC, whatever day the Monitor counts the request on.
 */
export const PHASES_BEGIN = '2026-09-21';
export const PHASES_BEGIN_MS = Date.parse(PHASES_BEGIN);

/** The phase a request row counts as, as SQL over a table alias (with its dot, or none): judged by the exact instant. */
export function requestPhaseSql(prefix = ''): string {
  return `CASE WHEN ${prefix}category = 'building' AND ${prefix}occurred_at < ${PHASES_BEGIN_MS} THEN 'unphased' ELSE ${prefix}category END`;
}

/**
 * The phase a totals row counts as: its stored one, which was judged by the
 * instant, except Building on a day before the cut-off. A day filed under the
 * old UTC rule holds the same instants either side of the cut-off as ever, and a
 * Belgian day before it holds only earlier ones, so this never moves a request.
 */
export function totalsPhaseSql(prefix = ''): string {
  return `CASE WHEN ${prefix}category = 'building' AND ${prefix}day < '${PHASES_BEGIN}' THEN 'unphased' ELSE ${prefix}category END`;
}

export const REVIEW_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const SPEEDS = ['standard', 'fast'] as const;
export const WHERE = ['local', 'cloud', 'actions'] as const;
export const SOURCES = ['hook', 'upload'] as const;

/** Most rows one write may carry. */
export const MAX_BATCH = 200;

export interface UsageRow {
  requestId: string;
  sessionId: string;
  occurredAt: number;
  /** The Belgian day the request is counted on. */
  day: string;
  branch: string | null;
  category: Category;
  reviewLevel: string | null;
  model: string;
  speed: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  /** The part of cacheCreationTokens written with the 1-hour lifetime; the rest is 5-minute. */
  cacheCreation1hTokens: number;
  cacheReadTokens: number;
  subagent: boolean;
  /** The kind of subagent (Explore, general-purpose, ...); only a subagent's request has one. */
  subagentType: string | null;
  /** Which subagent it was; only a subagent's request has one. */
  subagentId: string | null;
  ranWhere: string;
  source: string;
}

export type Validated = { ok: true; rows: UsageRow[] } | { ok: false; error: string };

/** A four-digit year and an explicit zone, so the UTC day is never guessed or malformed. */
export const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

const TOKEN_FIELDS =['inputTokens', 'outputTokens', 'cacheCreationTokens', 'cacheReadTokens'] as const;

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim() !== '' && value.length <= max ? value : null;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

/**
 * Checks a whole write. One bad row refuses the batch, and the error names the
 * row by its position (and its request id where it has one).
 */
export function validateBatch(body: unknown): Validated {
  const list = (body as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(list)) return { ok: false, error: 'The body must be {"rows": [...]}.' };
  if (list.length === 0) return { ok: false, error: 'The batch has no rows.' };
  if (list.length > MAX_BATCH) {
    return { ok: false, error: `The batch has ${list.length} rows; the most one write takes is ${MAX_BATCH}.` };
  }

  const rows: UsageRow[] = [];
  for (const [index, raw] of list.entries()) {
    const result = validateRow(raw);
    if (typeof result === 'string') {
      const id = text((raw as { requestId?: unknown } | null)?.requestId, 200);
      return { ok: false, error: `Row ${index}${id ? ` (${id})` : ''}: ${result}` };
    }
    rows.push(result);
  }
  return { ok: true, rows };
}

/**
 * The phases a stored Unphased request may be placed into again: where the
 * process step a session was in puts it when no mark decides. Every other phase
 * comes from marks, Actions or the security review, which the hook already sent.
 */
export const CORRECTABLE = ['scoping-planning', 'after-push', 'process-review', 'outside-process'] as const satisfies readonly Category[];
export type Correctable = (typeof CORRECTABLE)[number];

export interface Correction {
  requestId: string;
  category: Correctable;
}

export type ValidatedCorrections = { ok: true; corrections: Correction[] } | { ok: false; error: string };

/**
 * Checks a whole batch of corrections, `{"corrections": [{requestId, category}]}`.
 * One bad correction refuses the batch, naming its position and the value.
 */
export function validateCorrections(body: unknown): ValidatedCorrections {
  const list = (body as { corrections?: unknown } | null)?.corrections;
  if (!Array.isArray(list)) return { ok: false, error: 'The body must be {"corrections": [...]}.' };
  if (list.length === 0) return { ok: false, error: 'The batch has no corrections.' };
  if (list.length > MAX_BATCH) {
    return { ok: false, error: `The batch has ${list.length} corrections; the most one write takes is ${MAX_BATCH}.` };
  }
  const corrections: Correction[] = [];
  for (const [index, raw] of list.entries()) {
    const r = (typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
    const requestId = text(r.requestId, 200);
    if (!requestId) return { ok: false, error: `Correction ${index}: has no requestId.` };
    const category = oneOf(r.category, CORRECTABLE);
    if (!category) {
      return {
        ok: false,
        error: `Correction ${index} (${requestId}): has category "${String(r.category)}", which is not one of ${CORRECTABLE.join(', ')}.`,
      };
    }
    corrections.push({ requestId, category });
  }
  return { ok: true, corrections };
}

/** The row, or what is wrong with it. */
function validateRow(raw: unknown): UsageRow | string {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'is not an object.';
  const r = raw as Record<string, unknown>;

  const requestId = text(r.requestId, 200);
  if (!requestId) return 'has no requestId.';
  const sessionId = text(r.sessionId, 200);
  if (!sessionId) return 'has no sessionId.';
  if (typeof r.time !== 'string' || r.time.trim() === '') return 'has no time.';
  const when = new Date(r.time);
  if (!ISO_TIME.test(r.time) || Number.isNaN(when.getTime())) {
    return 'has a time that is not an ISO 8601 timestamp with a time zone.';
  }

  const category = oneOf(r.category, CATEGORIES);
  if (!category) return `has category "${String(r.category)}", which is not one of ${CATEGORIES.join(', ')}.`;

  let reviewLevel: string | null = null;
  if (r.reviewLevel !== undefined && r.reviewLevel !== null) {
    reviewLevel = oneOf(r.reviewLevel, REVIEW_LEVELS);
    if (!reviewLevel) {
      return `has reviewLevel "${String(r.reviewLevel)}", which is not one of ${REVIEW_LEVELS.join(', ')}.`;
    }
    if (category !== 'local-code-review') return 'has a reviewLevel, which only a local-code-review has.';
  }

  const model = text(r.model, 200);
  if (!model) return 'has no model.';
  const speed = oneOf(r.speed, SPEEDS);
  if (!speed) return `has speed "${String(r.speed)}", which is not one of ${SPEEDS.join(', ')}.`;
  const ranWhere = oneOf(r.ranWhere, WHERE);
  if (!ranWhere) return `has ranWhere "${String(r.ranWhere)}", which is not one of ${WHERE.join(', ')}.`;
  const source = oneOf(r.source, SOURCES);
  if (!source) return `has source "${String(r.source)}", which is not one of ${SOURCES.join(', ')}.`;
  if (typeof r.subagent !== 'boolean') return 'has a subagent that is not true or false.';

  const identity: Record<'subagentType' | 'subagentId', string | null> = { subagentType: null, subagentId: null };
  for (const field of ['subagentType', 'subagentId'] as const) {
    const v = r[field];
    if (v === undefined || v === null) continue;
    identity[field] = text(v, 100);
    if (!identity[field]) return `has a ${field} that is not a short string.`;
    if (!r.subagent) return `has a ${field}, which only a subagent's request has.`;
  }

  let branch: string | null = null;
  if (r.branch !== undefined && r.branch !== null && r.branch !== '') {
    branch = text(r.branch, 300);
    if (!branch) return 'has a branch that is not a short string.';
  }

  const counts: Record<string, number> = {};
  for (const field of TOKEN_FIELDS) {
    const value = r[field];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      return `has ${field} ${JSON.stringify(value)}, which is not a whole number of tokens, zero or more.`;
    }
    counts[field] = value;
  }

  // Optional, so a sender that cannot tell the two lifetimes apart prices all of it as 5-minute.
  let cacheCreation1hTokens = 0;
  if (r.cacheCreation1hTokens !== undefined && r.cacheCreation1hTokens !== null) {
    const v = r.cacheCreation1hTokens;
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > counts.cacheCreationTokens!) {
      return `has cacheCreation1hTokens ${JSON.stringify(v)}, which is not a whole number of tokens between zero and cacheCreationTokens.`;
    }
    cacheCreation1hTokens = v;
  }

  return {
    requestId,
    sessionId,
    occurredAt: when.getTime(),
    day: belgianDay(when.getTime()),
    branch,
    category,
    reviewLevel,
    model,
    speed,
    inputTokens: counts.inputTokens!,
    outputTokens: counts.outputTokens!,
    cacheCreationTokens: counts.cacheCreationTokens!,
    cacheCreation1hTokens,
    cacheReadTokens: counts.cacheReadTokens!,
    subagent: r.subagent,
    subagentType: identity.subagentType,
    subagentId: identity.subagentId,
    ranWhere,
    source,
  };
}
