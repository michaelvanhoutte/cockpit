import type { ClaudeCodeOutcome } from '@cockpit/shared';

/**
 * Firing a workspace's Claude Code routine: the test a connect, an edit or a
 * Test again runs ("Connect a workspace to Claude Code", issue 569), and the
 * real session an Agent starts on an Item ("Drop an agent on an item to start
 * a Claude Code session on it", issue 571).
 *
 * **Not the `Connector` SPI** (`@cockpit/connector-sdk`, architecture §6.2).
 * That interface is for a source Cockpit pulls Items from or takes a push
 * from; a Claude Code connection does neither; it is a credential a workspace
 * holds to fire a routine it made for itself, told apart from a real source
 * account by nothing at the storage layer (`connectorAccounts`, accounts
 * schema.ts).
 *
 * The request is Anthropic's documented one: `POST .../fire` with the
 * per-routine token, `anthropic-version`, and the run's context as `text`;
 * the answer names the session as `claude_code_session_url`.
 */

/** Where routines are fired, unless the environment names a stand-in (`CLAUDE_CODE_ROUTINES_ORIGIN`, env.ts). */
export const ANTHROPIC_ORIGIN = 'https://api.anthropic.com';

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whether an address is a Claude Code routine trigger at `origin`, and
 * nothing else - checked before any network call is made, so a pasted address
 * that is wrong in any way is refused without ever reaching the network
 * ("Connect a workspace to Claude Code", rule 2).
 *
 * Pure, and provable at L1 (tests/unit/engines/claude-code.test.ts)
 * without a fake network to stand behind it.
 */
export function isRoutineTriggerUrl(url: string, origin: string = ANTHROPIC_ORIGIN): boolean {
  return new RegExp(`^${escaped(origin)}/v1/claude_code/routines/[^/]+/fire$`).test(url);
}

/** The one-line instruction the test session is fired with. */
const TEST_PROMPT = 'Reply OK and stop.';

/**
 * How long a start waits on Claude before saying it does not know. Claude
 * answers once the session exists; past this, whether it does is Claude's to
 * say, not ours to guess.
 */
export const FIRE_TIMEOUT_MS = 30_000;

/** How Claude answered a fire, in the three ways a start has to tell apart. */
export type FireAnswer =
  /** Claude started a session - and here is its link, where the answer carried a usable one. */
  | { answered: 'accepted'; sessionUrl: string | null }
  /** Claude said no, and started nothing: `connection` is whether the connection itself is what it refused. */
  | { answered: 'refused'; message: string; connection: boolean }
  /** No answer arrived, so a session may or may not exist. */
  | { answered: 'unknown' };

/**
 * A refusal in words, by status ("Connect a workspace to Claude Code", rule
 * 1). A 4xx is Claude refusing this connection; anything else is Claude
 * failing on its own side, which says nothing about the connection.
 *
 * Pure, for the reason `isRoutineTriggerUrl` is.
 */
export function refusalFor(status: number): { message: string; connection: boolean } {
  if (status === 401) return { message: 'The token is wrong or was revoked.', connection: true };
  if (status === 404) return { message: 'That routine no longer exists.', connection: true };
  if (status === 429) {
    return {
      message: "Claude's limit for starting sessions was reached - try again later.",
      connection: true,
    };
  }
  if (status === 400) return { message: 'Claude refused the request - is the routine paused?', connection: true };
  if (status === 403) return { message: 'This Claude account cannot start routines.', connection: true };
  return { message: 'Claude could not be reached.', connection: false };
}

/**
 * The session link out of an accepted answer, or null where the answer does
 * not carry one a browser could open. Pure.
 */
export function sessionUrlFrom(body: unknown): string | null {
  const url = (body as { claude_code_session_url?: unknown } | null)?.claude_code_session_url;
  if (typeof url !== 'string' || url.length > 2048) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

/**
 * Fires a routine once. Never throws, and never retries: every retry would be
 * another session (issue 571, "Runs twice").
 *
 * **A fetch that throws is an unknown, not a refusal.** A timeout is the
 * common case, and a connection dropped after the request went out is the
 * same: the session may exist, so nothing here may say it failed.
 */
export async function fireRoutine(
  routineUrl: string,
  token: string,
  text: string,
  options: { origin?: string; timeoutMs?: number } = {},
): Promise<FireAnswer> {
  if (!isRoutineTriggerUrl(routineUrl, options.origin)) {
    return {
      answered: 'refused',
      message: 'That address is not a Claude Code routine trigger.',
      connection: true,
    };
  }

  let response: Response;
  try {
    response = await fetch(routineUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ text }),
      // The trigger address is checked above and never re-derived from
      // whatever comes back, so a redirect is never followed - there is
      // nowhere a real acceptance from Anthropic would ever send this. It
      // comes back as the 3xx itself, which is not `ok` and so reads as
      // Claude not reached. **`manual`, never `error`**: the Workers runtime
      // accepts only `follow` and `manual`, and `error` threw before any
      // request left, so every fire read as unreachable (issue 571; the
      // integration tests replace `fetch` and could not see it, the browser
      // walk in tests/e2e/agents.test.ts is what does).
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? FIRE_TIMEOUT_MS),
    });
  } catch {
    return { answered: 'unknown' };
  }

  if (!response.ok) return { answered: 'refused', ...refusalFor(response.status) };
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Accepted with a body that is not JSON: the session exists, its link does not.
  }
  return { answered: 'accepted', sessionUrl: sessionUrlFrom(body) };
}

/**
 * Fires the "reply OK and stop" test session a connect, an edit or a Test
 * again all run before anything is stored or changed ("Connect a workspace to
 * Claude Code", rule 1). Never throws: every way this can fail is something
 * the form has words for, not a fault.
 */
export async function testClaudeCodeConnection(
  routineUrl: string,
  token: string,
  origin?: string,
): Promise<ClaudeCodeOutcome> {
  const answer = await fireRoutine(routineUrl, token, TEST_PROMPT, origin ? { origin } : {});
  if (answer.answered === 'accepted') return { accepted: true };
  if (answer.answered === 'refused') return { accepted: false, message: answer.message };
  return { accepted: false, message: 'Claude could not be reached.' };
}
