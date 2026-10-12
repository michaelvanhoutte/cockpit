import type { ConnectorHost } from '@cockpit/connector-sdk';
import {
  credentialIn,
  credentialRefreshed,
  sealable,
  usableAccessToken,
  type OutlookCredential,
} from './credential.js';
import { MICROSOFT_ISSUER } from './sign-in.js';

/**
 * One mailbox, reached with its access token through Microsoft Graph -
 * refreshed where the held one has lapsed or Graph refuses it, and handed back
 * to the host before it is used, so a run that stops after a refresh leaves the
 * old credential in place or the new one, never neither.
 *
 * **Every call is spent from the run's budget** (`callsPerRun`, given by
 * whoever registers the connector), the refresh included, and the run stops
 * when it is gone.
 */

/** What the connection says while Microsoft no longer accepts its sign-in. */
export const SIGN_IN_REFUSED = 'Microsoft no longer accepts the sign-in. Connect again.';

/** What the connection says while the organisation has withdrawn what it approved for Cockpit. */
export const ORGANISATION_WITHDREW =
  'Your organisation no longer lets Cockpit read your mail. Ask an administrator to approve Cockpit again, then connect again.';

/** What the connection says while it holds a sign-in this connector cannot read. */
export const SIGN_IN_UNREADABLE = 'The stored Microsoft sign-in cannot be read. Connect again.';

/**
 * What the connection says while Microsoft rotated the refresh token and the
 * host did not keep the new one: the old one may no longer work, and nothing
 * should carry on holding a token nobody kept.
 */
export const SIGN_IN_NOT_KEPT = 'Cockpit could not keep the sign-in Microsoft renewed. Connect again.';

/** What a connector of this package needs to have been told about itself. */
export interface OutlookConnectorConfig {
  /** The client Microsoft issued this Cockpit (`MS_CLIENT_ID`), which a refresh is made with. */
  readonly clientId: string;
  readonly clientSecret: string;
  /**
   * How many calls to Microsoft one run may make, the refresh included. A
   * parameter because the number is measured on the generic host when the
   * connector is registered, against the platform's limit on calls out.
   */
  readonly callsPerRun: number;
  /** Who says whose mailbox is being connected. Defaults to Microsoft's multi-tenant issuer. */
  readonly issuer?: string;
  /**
   * Where Graph is reached. Defaults to Microsoft's. Never set in a
   * deployment: one that set it would send its access tokens wherever it pointed.
   */
  readonly apiOrigin?: string;
  /** The token endpoint, where it is not to be found in the issuer's discovery document. */
  readonly endpoints?: { readonly tokenEndpoint: string };
  /** Handed in by the tests, which must reach no network (docs/testing-strategy.md, "Third parties"). */
  readonly fetch?: typeof fetch;
  /** Read once per use, so a token is judged against the time it is used. */
  readonly now?: () => Date;
}

/** Microsoft refused the sign-in: nothing will work until it is connected again. */
export class SignInLost extends Error {
  constructor(why = SIGN_IN_REFUSED) {
    super(why);
  }
}
/** Graph or Microsoft did not answer usefully this time - a 5xx, a rate limit, the network. */
export class NotAnswering extends Error {}
/** The run's calls are spent; what is left is the next run's. */
export class OutOfCalls extends Error {}

interface Run {
  readonly calls: { left: number };
  mailbox: Promise<Mailbox> | null;
}

/** Keyed on the host a run is handed, so everything asked of one run spends one budget and refreshes one token. */
const runs = new WeakMap<ConnectorHost, Run>();

/** The mailbox of the connection this run is for, opened once. */
export function mailboxOf(host: ConnectorHost, config: OutlookConnectorConfig): Promise<Mailbox> {
  let run = runs.get(host);
  if (!run) {
    run = { calls: { left: config.callsPerRun }, mailbox: null };
    runs.set(host, run);
  }
  const held = run;
  held.mailbox ??= (async () => {
    const credential = credentialIn(await host.getCredentials());
    if (!credential) throw new SignInLost(SIGN_IN_UNREADABLE);
    return new Mailbox(host, config, credential, held.calls);
  })();
  return held.mailbox;
}

/** The requests' headers: **immutable ids always**, since Graph's default ids change when a message moves folder. */
const IMMUTABLE_IDS = 'IdType="ImmutableId"';

export class Mailbox {
  #token: string | null;
  readonly #origin: string;

  constructor(
    private readonly host: ConnectorHost,
    private readonly config: OutlookConnectorConfig,
    private credential: OutlookCredential,
    private readonly calls: { left: number },
  ) {
    this.#token = usableAccessToken(credential, this.#now());
    this.#origin = (config.apiOrigin?.trim() || 'https://graph.microsoft.com').replace(/\/$/, '');
  }

  /**
   * One read of Graph - a path under `/v1.0/me/`, or the `@odata.nextLink` a
   * page named - or null where what it names is not there. `bodyAsText` asks
   * for a message body as plain text.
   */
  async get(pathOrLink: string, options: { bodyAsText?: boolean } = {}): Promise<unknown> {
    const url = pathOrLink.startsWith('https://') || pathOrLink.startsWith('http://') ? pathOrLink : `${this.#origin}/v1.0/me/${pathOrLink}`;
    // A next link is followed only to the origin the token is meant for.
    if (!url.startsWith(`${this.#origin}/`)) throw new NotAnswering('Graph named a next page somewhere else');
    const prefer = options.bodyAsText ? `${IMMUTABLE_IDS}, outlook.body-content-type="text"` : IMMUTABLE_IDS;
    const token = this.#token ?? (await this.#refresh());
    let response = await this.#call(url, token, prefer);
    if (response.status === 401) {
      // A token Microsoft has stopped accepting early is refreshed once; a
      // second refusal is the sign-in's.
      response = await this.#call(url, await this.#refresh(), prefer);
      if (response.status === 401) throw new SignInLost();
    }
    if (response.status === 404) return null;
    const where = url.slice(this.#origin.length).split('?')[0];
    if (response.status === 408 || response.status === 429 || response.status >= 500) {
      throw new NotAnswering(`Graph answered ${response.status} to ${where}`);
    }
    // Anything else refused (a mailbox with no Exchange Online, a permission
    // an administrator took away) is not going to pass by asking again.
    if (!response.ok) throw new Error(`Microsoft refused the request for this mailbox: ${response.status} to ${where}`);
    return response.json();
  }

  async #call(url: string, token: string, prefer: string): Promise<Response> {
    this.#spend();
    try {
      return await (this.config.fetch ?? fetch)(url, { headers: { authorization: `Bearer ${token}`, prefer } });
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
    // A refresh token revoked, expired, for another client or whose consent an
    // administrator withdrew is answered 400 or 401; anything else is
    // Microsoft not answering this time.
    if (response.status === 400 || response.status === 401) {
      throw new SignInLost(consentWithdrawn(await response.json().catch(() => null)) ? ORGANISATION_WITHDREW : SIGN_IN_REFUSED);
    }
    if (!response.ok) throw new NotAnswering(`Microsoft answered ${response.status} to a refresh`);
    const refreshed = credentialRefreshed(this.credential, await response.json().catch(() => null), this.#now());
    if (!refreshed) throw new NotAnswering('Microsoft answered a refresh with no access token');
    // Handed back before it is used: a reconnect made meanwhile keeps its own.
    // Microsoft rotated the refresh token, so a credential nobody kept is one
    // to connect again rather than to carry on with.
    try {
      await this.host.setCredentials(sealable(refreshed));
    } catch {
      throw new SignInLost(SIGN_IN_NOT_KEPT);
    }
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

/**
 * Whether a refused refresh says the organisation, not the person, is why:
 * AADSTS65001 (consent missing or withdrawn) and AADSTS90094 (administrator
 * consent required).
 */
function consentWithdrawn(answer: unknown): boolean {
  const { error_codes: codes, error_description: description } = (answer ?? {}) as Record<string, unknown>;
  const withdrawn = [65001, 90094];
  if (Array.isArray(codes) && codes.some((code) => withdrawn.includes(Number(code)))) return true;
  return typeof description === 'string' && /AADSTS(65001|90094)/.test(description);
}

/** Microsoft's token endpoint, from the issuer's discovery document unless handed in. */
export async function endpointsOf(
  config: Pick<OutlookConnectorConfig, 'issuer' | 'endpoints' | 'fetch'>,
): Promise<{ tokenEndpoint: string }> {
  if (config.endpoints) return config.endpoints;
  const issuer = config.issuer?.trim() || MICROSOFT_ISSUER;
  let held = discovered.get(issuer);
  if (!held) {
    held = (async () => {
      const answer = await (config.fetch ?? fetch)(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`);
      if (!answer.ok) throw new NotAnswering(`the issuer's discovery document could not be read: ${answer.status}`);
      const document = (await answer.json()) as Record<string, unknown>;
      if (typeof document.token_endpoint !== 'string') {
        throw new NotAnswering('the issuer names nowhere to refresh a sign-in');
      }
      return { tokenEndpoint: document.token_endpoint };
    })();
    // Not cached as a failure: a lookup that failed once must not refuse every
    // refresh for as long as this isolate lives.
    held.catch(() => discovered.delete(issuer));
    discovered.set(issuer, held);
  }
  return held;
}

/** Held per issuer for the life of the isolate: the answer changes on the order of years. */
const discovered = new Map<string, Promise<{ tokenEndpoint: string }>>();
