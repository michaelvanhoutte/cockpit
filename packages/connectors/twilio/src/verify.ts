import { SourceError, type CodeChecked } from '@cockpit/connector-sdk';

/**
 * Twilio Verify, which texts a code and later says whether the one typed back
 * is it ("Connect a phone in Settings by confirming a code texted to it",
 * issue 1335).
 *
 * **Verify holds everything about a code**: the code itself, its ten-minute
 * expiry and its limit on wrong attempts. Cockpit keeps no pending state, so
 * what a check can answer is Verify's own `approved`, a wrong code, or one it
 * no longer accepts.
 */

export const VERIFY_ORIGIN = 'https://verify.twilio.com';

export interface VerifyConfig {
  readonly accountSid: string;
  readonly authToken: string;
  readonly serviceSid: string;
  /** Where Verify is reached; Twilio's own unless a local stack points it at its stand-in. */
  readonly origin?: string;
}

/** How long Verify is waited for: a person is waiting on the answer, so not longer. */
const WAIT_MS = 10_000;

/** Said where Verify could not be asked at all, or answered with a failure of its own. */
export const UNREACHABLE = 'Twilio could not be reached. Try again shortly.';
const WOULD_NOT_TEXT = 'Twilio would not text that number.';
const TOO_MANY_FOR_THE_NUMBER = 'Twilio would not send another code to that number yet. Try again in a few minutes.';

export async function sendCode(config: VerifyConfig, number: string): Promise<void> {
  const answer = await asked(config, 'Verifications', { To: number, Channel: 'sms' });
  if (answer.ok) return;
  throw new SourceError(
    answer.status === 429 ? TOO_MANY_FOR_THE_NUMBER : answer.status >= 500 ? UNREACHABLE : WOULD_NOT_TEXT,
    answer.status,
  );
}

export async function checkCode(config: VerifyConfig, number: string, code: string): Promise<CodeChecked> {
  const answer = await asked(config, 'VerificationCheck', { To: number, Code: code });
  // A verification that does not exist: never sent, already approved, or aged out.
  if (answer.status === 404) return 'gone';
  // A code Verify could not read as one, which is as wrong as one that does not match.
  if (answer.status === 400) return 'wrong';
  if (!answer.ok) throw new SourceError(UNREACHABLE, answer.status);

  const body = (await answer.json().catch(() => null)) as { status?: unknown } | null;
  switch (body?.status) {
    case 'approved':
      return 'approved';
    case 'pending':
      return 'wrong';
    // Canceled, expired, attempts used up: nothing typed now can be right.
    default:
      return 'gone';
  }
}

/** One call to Verify, as Twilio asks for it: a form body and the account's own credentials. */
async function asked(config: VerifyConfig, resource: string, form: Record<string, string>): Promise<Response> {
  const origin = config.origin ?? VERIFY_ORIGIN;
  const url = `${origin}/v2/Services/${encodeURIComponent(config.serviceSid)}/${resource}`;
  try {
    return await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Basic ${btoa(`${config.accountSid}:${config.authToken}`)}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(form),
      signal: AbortSignal.timeout(WAIT_MS),
    });
  } catch {
    // No fetch error text: it can carry the address.
    throw new SourceError(UNREACHABLE);
  }
}
