import { emailLocalPartSchema } from '@cockpit/shared';
import type { Env } from '../env.js';
import { openAccount } from '../accounts/index.js';
import { forgetUnconfirmed, whoseAddress } from './register.js';

/**
 * Mail to an Email to Cockpit address, as the Worker's email event hands it
 * over ("Get an Email to Cockpit address, and receive mail at it", issue 1466):
 * the part of Cloudflare's `ForwardableEmailMessage` read here, so a test can
 * hand in its own.
 */
export interface MailArriving {
  readonly to: string;
  readonly headers: Headers;
  readonly rawSize: number;
  setReject(reason: string): void;
}

/** What Email Routing answers the sender of a rejected mail, as a permanent error. */
export const REJECTED_BECAUSE = 'No such address';

/**
 * The headers that say how the mail was authenticated, logged whole: what
 * Email Routing hands the Worker is what the spike records, before anything
 * is trusted ("Email Cockpit to capture a note", issue 1455, Technical design).
 */
const AUTHENTICATION_HEADERS = ['authentication-results', 'arc-authentication-results', 'received-spf'] as const;

/**
 * The random part a mail is addressed to, where it is addressed to this
 * environment's domain in the shape an address is made in; null for anything
 * else, which nobody can hold.
 */
export function heldPartOf(to: string, domain: string | undefined): string | null {
  if (!domain) return null;
  const at = to.lastIndexOf('@');
  if (at < 0) return null;
  if (to.slice(at + 1).toLowerCase() !== domain.toLowerCase()) return null;
  const localPart = to.slice(0, at).toLowerCase();
  return emailLocalPartSchema.safeParse(localPart).success ? localPart : null;
}

/**
 * How a mail was authenticated, as far as its headers say: the three results
 * headers whole, and of each DKIM signature only the domain and selector that
 * signed it. Plus the name of every header it carries, so the spike sees what
 * Email Routing added. Never a value that could hold what the mail says.
 */
export function authenticationOf(headers: Headers): Record<string, unknown> {
  const results: Record<string, unknown> = {};
  for (const name of AUTHENTICATION_HEADERS) {
    const value = headers.get(name);
    if (value !== null) results[name] = value;
  }
  const signature = headers.get('dkim-signature');
  if (signature !== null) {
    const tag = (name: string) => new RegExp(`(?:^|;)\\s*${name}=([^;]*)`).exec(signature)?.[1]?.trim() ?? null;
    results['dkim-signature'] = { d: tag('d'), s: tag('s') };
  }
  const names: string[] = [];
  headers.forEach((_value, name) => names.push(name));
  results.headerNames = names;
  return results;
}

/**
 * One mail, decided in one pass:
 *
 * | The mail is to | What happens |
 * |---|---|
 * | an address no store holds, or no address this environment makes | rejected with a permanent error, so the sender gets a bounce; a register row the store did not confirm is swept |
 * | an address its account's store holds | taken, logged in one line naming the account and the authentication results, and dropped: nothing is captured yet |
 *
 * **A rejected mail cannot be taken back**, so rejection is only for an address
 * no store holds, asked of the store itself rather than of the register's row.
 *
 * **What the event throwing does is unknown**, so a throw is logged before it
 * is passed on, and `EMAIL_EVENT_THROWS` makes one on purpose for the spike.
 */
export async function receiveMail(message: MailArriving, env: Env, now: Date = new Date()): Promise<void> {
  try {
    const localPart = heldPartOf(message.to, env.EMAIL_DOMAIN);
    const row = localPart === null ? null : await whoseAddress(env, localPart);
    const held =
      localPart !== null && row !== null && (await (await openAccount(env, row.accountName)).holdsEmailAddress(localPart));

    if (!held || row === null) {
      const swept = localPart !== null && row !== null && (await forgetUnconfirmed(env, localPart, row, now));
      message.setReject(REJECTED_BECAUSE);
      console.log(
        JSON.stringify({
          level: 'info',
          message: 'mail to an Email to Cockpit address nobody holds was rejected',
          ...(row ? { account: row.accountName, swept } : {}),
        }),
      );
      return;
    }

    console.log(
      JSON.stringify({
        level: 'info',
        message: 'mail to an Email to Cockpit address arrived and was dropped: nothing is captured yet',
        account: row.accountName,
        size: message.rawSize,
        authentication: authenticationOf(message.headers),
      }),
    );
    if (env.EMAIL_EVENT_THROWS === 'true') throw new Error('thrown on purpose, EMAIL_EVENT_THROWS being set');
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        message: 'the email event threw',
        cause: error instanceof Error ? error.message : String(error),
      }),
    );
    throw error;
  }
}
