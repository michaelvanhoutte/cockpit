import type { ConnectorHost } from '@cockpit/connector-sdk';
import {
  credentialIn,
  credentialRefreshed,
  sealable,
  usableAccessToken,
  type GmailCredential,
} from './credential.js';
import { labelChangeRefusal } from './messages.js';

/**
 * One mailbox, reached with its access token - refreshed where the held one has
 * lapsed or Gmail refuses it, and handed back to the host before it is used, so
 * a run that stops after a refresh leaves the old token in place or the new
 * one, never neither.
 *
 * **Every call is spent from the run's budget** (`CALLS_PER_RUN`), the refresh
 * included, and the run stops when it is gone.
 */

/**
 * How many calls to Google one run may make, set from a measurement on the
 * generic host ("Switch Gmail onto the generic host, and take it out of the
 * core", issue 944). The Workers free plan allows 50 calls out per invocation,
 * and a busy first run spends these 40 and one more, reading the issuer's
 * discovery document once per isolate; its store round trips and queue sends
 * (about five per conversation filed) count against the separate 1,000 for
 * Cloudflare's own services. apps/api's gmail-on-the-host.test.ts holds a run
 * to both.
 */
export const CALLS_PER_RUN = 40;

/** What the connection says while Google no longer accepts its sign-in. */
export const SIGN_IN_REFUSED = 'Google no longer accepts the sign-in. Connect again.';

/** What a connector of this package needs to have been told about itself. */
export interface GmailConnectorConfig {
  /** The client Google issued this Cockpit for Gmail, which a refresh is made with. */
  readonly clientId: string;
  readonly clientSecret: string;
  /**
   * Who says whose mailbox is being connected. Defaults to Google, and is
   * pointed at the local stub by `pnpm dev`, for the reason a path nobody can
   * drive locally is one nobody checks.
   */
  readonly issuer?: string;
  /**
   * Where Gmail's API is reached. Defaults to Google's, and is pointed at the
   * stub's stand-in mailbox locally. Never set in a deployment: one that set it
   * would send its access tokens wherever it pointed.
   */
  readonly apiOrigin?: string;
  /** The token and revocation endpoints, where they are not to be found in the issuer's discovery document. */
  readonly endpoints?: { readonly tokenEndpoint: string; readonly revocationEndpoint?: string };
  /** Handed in by the tests, which must reach no network (docs/testing-strategy.md, "Third parties"). */
  readonly fetch?: typeof fetch;
  /** Read once per use, so a token is judged against the time it is used. */
  readonly now?: () => Date;
}

/** Google refused the sign-in: nothing will work until it is connected again. */
export class SignInLost extends Error {
  constructor(why = SIGN_IN_REFUSED) {
    super(why);
  }
}
/** Gmail or Google did not answer usefully this time - a 5xx, a rate limit, the network. */
export class NotAnswering extends Error {}
/** Gmail holding the mailbox back for now, so a change it was asked for waits for the next run. */
export class HeldBack extends NotAnswering {}
/** Gmail refusing a change in a way asking again will not alter; `status` is what it answered. */
export class ChangeRefused extends Error {
  constructor(readonly status: number) {
    super(`Gmail refused the change: ${status}`);
  }
}
/** The run's calls are spent; what is left is the next run's. */
export class OutOfCalls extends Error {}

/** Where a run is: the calls it has left and the one mailbox it reads, shared by everything the host asks of it. */
interface Run {
  readonly calls: { left: number };
  mailbox: Promise<Mailbox> | null;
}

/**
 * Keyed on the host a run is handed, which is the same object for the push of
 * waiting open states and for the read after it - so the two spend one budget
 * and refresh one token.
 */
const runs = new WeakMap<ConnectorHost, Run>();

/** The mailbox of the connection this run is for, opened once. */
export function mailboxOf(host: ConnectorHost, config: GmailConnectorConfig): Promise<Mailbox> {
  let run = runs.get(host);
  if (!run) {
    run = { calls: { left: CALLS_PER_RUN }, mailbox: null };
    runs.set(host, run);
  }
  const held = run;
  held.mailbox ??= (async () => {
    const credential = credentialIn(await host.getCredentials());
    if (!credential) throw new SignInLost('the stored sign-in could not be read. Connect again.');
    return new Mailbox(host, config, credential, held.calls);
  })();
  return held.mailbox;
}

export class Mailbox {
  #token: string | null;

  constructor(
    private readonly host: ConnectorHost,
    private readonly config: GmailConnectorConfig,
    private credential: GmailCredential,
    private readonly calls: { left: number },
  ) {
    this.#token = usableAccessToken(credential, this.#now());
  }

  /** One read of Gmail's API, or null where what it names is not there. */
  get(path: string): Promise<unknown> {
    return this.#ask(path);
  }

  /** One change through Gmail's API - its answer, or null where what it names is not there. */
  post(path: string, body: unknown): Promise<unknown> {
    return this.#ask(path, body);
  }

  async #ask(path: string, body?: unknown): Promise<unknown> {
    const token = this.#token ?? (await this.#refresh());
    let response = await this.#call(path, token, body);
    if (response.status === 401) {
      // A token Google has stopped accepting early is refreshed once; a
      // second refusal is the sign-in's.
      response = await this.#call(path, await this.#refresh(), body);
      if (response.status === 401) throw new SignInLost();
    }
    if (response.status === 404) return null;
    if (!response.ok && body !== undefined && response.status < 500) {
      const refusal = labelChangeRefusal(response.status, await response.json().catch(() => null));
      if (refusal === 'never') throw new ChangeRefused(response.status);
      throw new HeldBack(`Gmail answered ${response.status} to a change`);
    }
    if (!response.ok) {
      const failure = `Gmail answered ${response.status} to ${path.split('?')[0]}`;
      throw body !== undefined ? new HeldBack(failure) : new NotAnswering(failure);
    }
    return response.json();
  }

  async #call(path: string, token: string, body?: unknown): Promise<Response> {
    this.#spend();
    const origin = this.config.apiOrigin?.trim() || 'https://gmail.googleapis.com';
    try {
      return await (this.config.fetch ?? fetch)(
        `${origin}/gmail/v1/users/me/${path}`,
        body === undefined
          ? { headers: { authorization: `Bearer ${token}` } }
          : {
              method: 'POST',
              headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
              body: JSON.stringify(body),
            },
      );
    } catch (error) {
      throw new NotAnswering(error instanceof Error ? error.message : String(error));
    }
  }

  async #refresh(): Promise<string> {
    this.#spend();
    let response: Response;
    try {
      const { tokenEndpoint } = await endpointsOf(this.config);
      response = await (this.config.fetch ?? fetch)(tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: this.credential.refreshToken,
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
        }),
      });
    } catch (error) {
      throw new NotAnswering(error instanceof Error ? error.message : String(error));
    }
    // A refresh token revoked, expired or for another client is answered
    // 400 or 401 (`invalid_grant`, `invalid_client`); anything else is Google
    // not answering this time.
    if (response.status === 400 || response.status === 401) throw new SignInLost();
    if (!response.ok) throw new NotAnswering(`Google answered ${response.status} to a refresh`);
    const refreshed = credentialRefreshed(this.credential, await response.json().catch(() => null), this.#now());
    if (!refreshed) throw new NotAnswering('Google answered a refresh with no access token');
    // Handed back before it is used: a reconnect made meanwhile keeps its own.
    await this.host.setCredentials(sealable(refreshed));
    this.credential = refreshed;
    this.#token = refreshed.accessToken;
    return refreshed.accessToken!;
  }

  #spend(): void {
    if (this.calls.left <= 0) throw new OutOfCalls();
    this.calls.left -= 1;
  }

  #now(): Date {
    return this.config.now?.() ?? new Date();
  }
}

/** Google's token and revocation endpoints, from the issuer's discovery document unless handed in. */
export async function endpointsOf(
  config: Pick<GmailConnectorConfig, 'issuer' | 'endpoints' | 'fetch'>,
): Promise<{ tokenEndpoint: string; revocationEndpoint?: string }> {
  if (config.endpoints) return config.endpoints;
  const issuer = config.issuer?.trim() || 'https://accounts.google.com';
  let held = discovered.get(issuer);
  if (!held) {
    held = (async () => {
      const answer = await (config.fetch ?? fetch)(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`);
      if (!answer.ok) throw new NotAnswering(`the issuer's discovery document could not be read: ${answer.status}`);
      const document = (await answer.json()) as Record<string, unknown>;
      if (typeof document.token_endpoint !== 'string') {
        throw new NotAnswering('the issuer names nowhere to refresh a sign-in');
      }
      return {
        tokenEndpoint: document.token_endpoint,
        ...(typeof document.revocation_endpoint === 'string' ? { revocationEndpoint: document.revocation_endpoint } : {}),
      };
    })();
    // Not cached as a failure: a lookup that failed once must not refuse every
    // refresh for as long as this isolate lives.
    held.catch(() => discovered.delete(issuer));
    discovered.set(issuer, held);
  }
  return held;
}

/** Held per issuer for the life of the isolate: the answer changes on the order of years. */
const discovered = new Map<string, Promise<{ tokenEndpoint: string; revocationEndpoint?: string }>>();
