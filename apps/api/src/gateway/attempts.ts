/**
 * The gateway every paid provider call goes through ("Record every paid
 * provider call through one gateway", issue 902): it makes the attempts, owns
 * the retry, and hands one record per settled attempt to a recorder.
 *
 * Nothing here names a provider, a binding or D1, so it is proved at L1 with
 * the recorder, the clock and the wait injected; `ai/index.ts` supplies
 * Claude's own policy and `record.ts` the recorder that writes D1.
 */

/** What a call was for and who it was for - the same on every attempt at it. */
export interface CallAbout {
  /** What was asked: `clean-up-a-note`, `choose-a-panel`. */
  operation: string;
  /** The prompt file the call was built from, e.g. `clean-up-a-note.v11`. */
  promptVersion: string | null;
  /** What started it (`Trigger`), or `null` for a job queued before it was carried. */
  triggeredBy: Trigger | null;
  accountName: string;
  itemId: string | null;
  provider: string;
  model: string;
  paidBy: PaidBy;
}

/**
 * What started a call, as the record names it. A connector's own captures
 * name it by its id (`connector:teams`), so one added later is named without
 * a change here.
 */
export type Trigger = 'captured-in-app' | 'mcp' | 'gmail-check' | 'panel-settled' | `connector:${string}`;

/** Whose money a call spent: today only Cockpit's own Anthropic key. */
export interface PaidBy {
  kind: 'cockpit-anthropic-key';
  /** The Anthropic workspace the key is scoped to, where one is configured. */
  account: string | null;
  /** The key's last 4 characters, as the Console shows them - never more. */
  keyEnding: string;
}

/** The four counts a provider reports, each `null` where it reports none. */
export interface Tokens {
  tokensIn: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  tokensOut: number | null;
}

export type Outcome = { outcome: 'ok' } | { outcome: 'error'; status: number | null } | { outcome: 'timed-out' };

/** One settled attempt. Never the prompt, the answer, or a whole key. */
export type AttemptRecord = CallAbout &
  Outcome &
  Tokens & {
    /** When the attempt started, ISO-8601. */
    at: string;
    durationMs: number;
  };

export type Recorder = (record: AttemptRecord) => Promise<void>;

/** How one provider's failures are read: which are worth a second attempt, and after how long. */
export interface RetryPolicy {
  /** Further attempts after the first. */
  retries: number;
  /** What a failed attempt's record says. */
  outcomeOf(error: unknown): Outcome;
  /** Whether a failed attempt is worth another, and how many milliseconds to wait first; `null` where it is not. */
  retryAfter(error: unknown, attempt: number): number | null;
}

export interface Around {
  record: Recorder;
  /** Milliseconds, for the duration; only differences are used. */
  clock: () => number;
  /** The time the attempt started, for its record. */
  now: () => Date;
  wait: (ms: number) => Promise<void>;
}

const NO_TOKENS: Tokens = { tokensIn: null, cacheRead: null, cacheWrite: null, tokensOut: null };

/**
 * Makes `attempt` until one succeeds or the policy declines another, recording
 * each, and answers the value or throws the last failure.
 *
 * **Recording never costs the call.** A recorder that throws is logged and the
 * call goes on: the record is kept beside the work, and a note that was
 * cleaned up must not be redone, or left undone, because its record was lost.
 */
export async function callThrough<T>(
  about: CallAbout,
  attempt: () => Promise<{ value: T; tokens: Tokens | null }>,
  policy: RetryPolicy,
  around: Around,
): Promise<T> {
  for (let tried = 0; ; tried += 1) {
    const at = around.now().toISOString();
    const started = around.clock();
    try {
      const { value, tokens } = await attempt();
      await recordSafely(around.record, {
        ...about,
        outcome: 'ok',
        ...(tokens ?? NO_TOKENS),
        at,
        durationMs: around.clock() - started,
      });
      return value;
    } catch (error) {
      await recordSafely(around.record, {
        ...about,
        ...policy.outcomeOf(error),
        ...NO_TOKENS,
        at,
        durationMs: around.clock() - started,
      });
      const delay = tried < policy.retries ? policy.retryAfter(error, tried + 1) : null;
      if (delay === null) throw error;
      await around.wait(delay);
    }
  }
}

async function recordSafely(record: Recorder, row: AttemptRecord): Promise<void> {
  try {
    await record(row);
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        message: `a ${row.operation} call was not recorded: ${error instanceof Error ? error.message : String(error)}`,
      }),
    );
  }
}
