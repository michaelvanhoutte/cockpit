import type { ClaudeCodeOutcome } from '@cockpit/shared';

/**
 * Testing a workspace's Claude Code routine trigger ("Connect a workspace to
 * Claude Code", issue 569).
 *
 * **Not the `Connector` SPI** (`@cockpit/connector-sdk`, architecture §6.2).
 * That interface is for a source Cockpit pulls Items from or takes a push
 * from; a Claude Code connection does neither; it is a credential a workspace
 * holds to fire a routine it made for itself, told apart from a real source
 * account by nothing at the storage layer (`connectorAccounts`, accounts
 * schema.ts). So this module is nothing but the one thing Claude Code needs
 * that Teams does not: proving a routine trigger before anything is stored.
 */

/** Only Anthropic's own routine trigger address is ever called (rule 2). */
const ROUTINE_TRIGGER = /^https:\/\/api\.anthropic\.com\/v1\/claude_code\/routines\/[^/]+\/fire$/;

/**
 * Whether an address is a Claude Code routine trigger, and nothing else -
 * checked before any network call is made, so a pasted address that is wrong
 * in any way is refused without ever reaching the network (rule 2).
 *
 * Pure, and provable at L1 (tests/unit/connectors/claude-code.test.ts)
 * without a fake network to stand behind it.
 */
export function isRoutineTriggerUrl(url: string): boolean {
  return ROUTINE_TRIGGER.test(url);
}

/** The one-line instruction the test session is fired with. */
const TEST_PROMPT = 'Reply OK and stop.';

/**
 * Fires the "reply OK and stop" test session a connect, an edit or a Test
 * again all run before anything is stored or changed (rule 1). Never throws:
 * every way this can fail is something the form has words for, not a fault.
 */
export async function testClaudeCodeConnection(
  routineUrl: string,
  token: string,
): Promise<ClaudeCodeOutcome> {
  if (!isRoutineTriggerUrl(routineUrl)) {
    return { accepted: false, message: 'That address is not a Claude Code routine trigger.' };
  }

  let response: Response;
  try {
    response = await fetch(routineUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: TEST_PROMPT }),
      // The trigger address is checked above and never re-derived from
      // whatever comes back, so a redirect is refused rather than followed -
      // there is nowhere a real acceptance from Anthropic would ever send
      // this (found in review).
      redirect: 'error',
    });
  } catch {
    return { accepted: false, message: 'Claude could not be reached.' };
  }

  if (response.ok) return { accepted: true };
  if (response.status === 401) {
    return { accepted: false, message: 'The token is wrong or was revoked.' };
  }
  if (response.status === 404) {
    return { accepted: false, message: 'That routine no longer exists.' };
  }
  if (response.status === 429) {
    return {
      accepted: false,
      message: "Claude's limit for starting sessions was reached - try again later.",
    };
  }
  return { accepted: false, message: 'Claude could not be reached.' };
}
