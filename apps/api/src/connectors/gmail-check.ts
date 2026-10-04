import type { Env } from '../env.js';
import { endpointsFor, gmailIssuerFor } from '../auth/issuer.js';
import { enqueueCleanUp, enqueueReadingItsMeaning } from '../jobs/enrichment.js';
import { open, seal, sealingKey, type Sealed } from './credential-crypto.js';
import {
  cockpitLabelIn,
  conversationFrom,
  conversationPage,
  credentialRefreshed,
  gmailCredentialIn,
  usableAccessToken,
  type GmailConversation,
  type GmailCredential,
} from './gmail.js';
import { derivedUuid } from './push-host.js';

/**
 * Checking an account's Gmail connections, which its store's alarm does every
 * five minutes while it holds one ("Bring in the conversations already
 * labelled Cockpit as tasks", issue 725).
 *
 * **The I/O half, and only that.** What a conversation brings in, which
 * label is Cockpit's and what a refresh leaves sealed are decided in
 * `gmail.ts` and proved at L1; what this does with Gmail and the store is
 * proved through the store's own alarm at L2, with Gmail faked at the
 * network boundary (tests/integration/http/gmail-import.test.ts).
 *
 * **A full reconcile, here creating only**: the history position is recorded
 * first, for "Bring in a conversation within five minutes of labelling it
 * Cockpit" (issue 726) to start from, then the labelled conversations are
 * listed a page at a time - each page's new conversations read and brought
 * in before the next page is asked for, and the page persisted only once all
 * of them are. So a run that stops resumes at the page it stopped in, and a
 * conversation already brought in is found again by its link rather than
 * read again.
 */

/**
 * How many calls one run may make. The Workers free plan allows 50 outbound
 * requests per invocation, an alarm's included; this leaves room for the
 * issuer's discovery document and the queue sends beside them.
 */
export const CALLS_PER_RUN = 40;

/**
 * How many labelled conversations Gmail is asked for at a time: about what one
 * run can read, so a page is rarely listed twice, and well under Gmail's own
 * ceiling of 500.
 */
const PAGE_SIZE = 50;

/** What the account row says while a connection cannot be checked - after "Failing:". */
export const NO_LABEL =
  'there is no label called Cockpit in this account. Create it in Gmail, and label the conversations to bring in.';
export const SIGN_IN_REFUSED = 'Google no longer accepts the sign-in. Connect again.';

/** One Gmail connection of the account, as the store holds it. */
export interface GmailConnectionToCheck {
  readonly id: string;
  readonly workspaceId: string;
  /** Google's own name for the mailbox (`external_account_key`). */
  readonly mailboxKey: string;
  /** The mailbox's address, which is what the row is called. */
  readonly address: string;
  readonly sealed: Sealed;
}

/** Where bringing in one connection's conversations has got to (`gmail_checks`). */
export interface GmailProgress {
  readonly historyId: string;
  readonly pageToken: string | null;
  readonly listedAt: string | null;
}

/** What the store does for a check: everything it reads and writes, synchronously, and nothing else. */
export interface GmailCheckHost {
  readonly accountName: string;
  connections(): GmailConnectionToCheck[];
  progress(sourceAccountId: string): GmailProgress | null;
  /** A reconcile beginning, at this history position. */
  startListing(sourceAccountId: string, historyId: string, at: string): void;
  /** One page done: the next one to ask for, or the listing finished. */
  pageListed(sourceAccountId: string, nextPageToken: string | null, at: string): void;
  /** Which of these conversations this mailbox has already brought into this Workspace. */
  alreadyBroughtIn(workspaceId: string, mailboxKey: string, threadIds: readonly string[]): Set<string>;
  /**
   * Makes the conversation's Item and links them - unless the connection has
   * gone since the run read it. Answers whether the link was written now,
   * which is what owes the Item its clean-up.
   */
  bringIn(
    connection: GmailConnectionToCheck,
    conversation: GmailConversation,
    ids: { itemId: string; commandId: string },
    at: string,
  ): 'linked' | 'already linked' | 'disconnected';
  /**
   * The connection's credential, sealed again around a refreshed access token
   * - only where it still holds `was`, so a reconnect made meanwhile keeps its
   * own. Answers whether it did.
   */
  reseal(sourceAccountId: string, was: Sealed, sealed: Sealed): boolean;
  /** The connection was checked: it reads "last checked" and nothing says it is failing. */
  checked(sourceAccountId: string, at: string): void;
  /** The connection cannot be checked, and why. */
  failing(sourceAccountId: string, reason: string, at: string): void;
}

/** Google refused the sign-in: nothing will work until it is connected again. */
class SignInRefused extends Error {}
/** Gmail or Google did not answer usefully this time - a 5xx, a rate limit, the network. */
class NotAnswering extends Error {}
/** The run's calls are spent; what is left is the next run's. */
class OutOfCalls extends Error {}
/** The connection was disconnected or connected again while the run was reading it; the next run reads it afresh. */
class ConnectionChanged extends Error {}

/**
 * Checks every Gmail connection the account holds, as far as one run's calls
 * go - and answers whether there is more to do than this run reached, so the
 * alarm can come back sooner than five minutes.
 */
export async function checkGmail(env: Env, host: GmailCheckHost, now: Date): Promise<{ moreToDo: boolean }> {
  const connections = host.connections();
  if (connections.length === 0) return { moreToDo: false };
  const clientId = env.GMAIL_CLIENT_ID?.trim();
  const clientSecret = env.GMAIL_CLIENT_SECRET?.trim();
  const key = await sealingKey(env.CONNECTOR_CREDENTIAL_KEY);
  if (!clientId || !clientSecret || !key) {
    logged('error', 'Gmail connections were not checked: this environment cannot connect Gmail');
    return { moreToDo: false };
  }

  const calls = { left: CALLS_PER_RUN };
  const broughtIn: string[] = [];
  let moreToDo = false;
  for (const connection of connections) {
    // The fewest one check can make: the label, then a page.
    if (calls.left < 3) {
      moreToDo = true;
      break;
    }
    const at = now.toISOString();
    try {
      const opened = await open(connection.sealed, key);
      const credential = opened === null ? null : gmailCredentialIn(opened);
      if (!credential) throw new SignInRefused('the sign-in could not be read');
      let held = connection.sealed;
      const mailbox = new Mailbox(env, { clientId, clientSecret }, credential, now, calls, async (refreshed) => {
        const sealed = await seal(JSON.stringify(refreshed), key);
        if (!host.reseal(connection.id, held, sealed)) throw new ConnectionChanged('the sign-in was replaced');
        held = sealed;
      });
      const reached = await bringInLabelled(host, connection, mailbox, at, broughtIn);
      if (reached === 'no label') {
        host.failing(connection.id, NO_LABEL, at);
        continue;
      }
      if (reached === 'more to do') moreToDo = true;
      host.checked(connection.id, at);
    } catch (error) {
      if (error instanceof SignInRefused) {
        host.failing(connection.id, SIGN_IN_REFUSED, at);
      } else if (error instanceof OutOfCalls) {
        moreToDo = true;
        host.checked(connection.id, at);
      } else if (error instanceof ConnectionChanged) {
        // Disconnected, or connected again - which arms a check of its own.
        continue;
      } else {
        // Nothing is changed and nothing said: the next run tries again.
        logged('warn', 'a Gmail connection could not be checked this time', {
          sourceAccountId: connection.id,
          cause: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  // The clean-up every captured Item gets, once the run's own writes are done.
  for (const itemId of broughtIn) {
    await enqueueCleanUp(env, host.accountName, itemId);
    await enqueueReadingItsMeaning(env, host.accountName, itemId);
  }
  return { moreToDo };
}

/** Lists the labelled conversations from where the last run stopped, bringing in each one not yet in. */
async function bringInLabelled(
  host: GmailCheckHost,
  connection: GmailConnectionToCheck,
  mailbox: Mailbox,
  at: string,
  broughtIn: string[],
): Promise<'no label' | 'done' | 'more to do'> {
  const labelId = cockpitLabelIn(await mailbox.get('labels'));
  if (!labelId) return 'no label';

  let progress = host.progress(connection.id);
  if (!progress) {
    // The position first, so whatever is labelled while the listing runs is
    // after it, and the next slice's history reads it.
    const profile = (await mailbox.get('profile')) as { historyId?: unknown } | null;
    const historyId = profile?.historyId;
    if (typeof historyId !== 'string' && typeof historyId !== 'number') {
      throw new NotAnswering('Gmail gave no history position');
    }
    host.startListing(connection.id, String(historyId), at);
    progress = host.progress(connection.id)!;
  }

  while (!progress.listedAt) {
    const query = new URLSearchParams({ labelIds: labelId, maxResults: String(PAGE_SIZE) });
    if (progress.pageToken) query.set('pageToken', progress.pageToken);
    const page = conversationPage(await mailbox.get(`threads?${query}`));
    const known = host.alreadyBroughtIn(connection.workspaceId, connection.mailboxKey, page.threadIds);
    for (const threadId of page.threadIds.filter((id) => !known.has(id))) {
      const thread = await mailbox.get(`threads/${encodeURIComponent(threadId)}?format=full`);
      // Gone between the listing and the read - deleted, or no longer there
      // to read - is nothing to bring in.
      const conversation = thread === null ? null : conversationFrom(thread, labelId, connection.address);
      if (!conversation) continue;
      const named = `gmail:${connection.workspaceId}:${connection.mailboxKey}:${threadId}`;
      const ids = { itemId: await derivedUuid(`item:${named}`), commandId: await derivedUuid(`capture:${named}`) };
      const linked = host.bringIn(connection, conversation, ids, at);
      if (linked === 'disconnected') throw new ConnectionChanged('the connection was disconnected');
      if (linked === 'linked') broughtIn.push(ids.itemId);
    }
    host.pageListed(connection.id, page.nextPageToken, at);
    const next = host.progress(connection.id);
    // Gone: connected again meanwhile, which starts the listing over.
    if (!next) throw new ConnectionChanged('the listing was started again');
    progress = next;
  }
  return 'done';
}

/**
 * One mailbox, reached with its access token - refreshed where the cached one
 * has lapsed or Gmail refuses it, and sealed again before it is used, so a run
 * that stops after a refresh leaves the old token in place or the new one,
 * never neither.
 */
class Mailbox {
  #token: string | null;

  constructor(
    private readonly env: Env,
    private readonly client: { clientId: string; clientSecret: string },
    private credential: GmailCredential,
    private readonly now: Date,
    private readonly calls: { left: number },
    private readonly keep: (refreshed: GmailCredential) => Promise<void>,
  ) {
    this.#token = usableAccessToken(credential, now);
  }

  /** One read of Gmail's API, or null where what it names is not there. */
  async get(path: string): Promise<unknown> {
    const token = this.#token ?? (await this.#refresh());
    let response = await this.#call(path, token);
    if (response.status === 401) {
      // A token Google has stopped accepting early is refreshed once; a
      // second refusal is the sign-in's.
      response = await this.#call(path, await this.#refresh());
      if (response.status === 401) throw new SignInRefused('Gmail refused a fresh access token');
    }
    if (response.status === 404) return null;
    if (!response.ok) throw new NotAnswering(`Gmail answered ${response.status} to ${path.split('?')[0]}`);
    return response.json();
  }

  async #call(path: string, token: string): Promise<Response> {
    this.#spend();
    const origin = this.env.GMAIL_API_ORIGIN?.trim() || 'https://gmail.googleapis.com';
    try {
      return await fetch(`${origin}/gmail/v1/users/me/${path}`, { headers: { authorization: `Bearer ${token}` } });
    } catch (error) {
      throw new NotAnswering(error instanceof Error ? error.message : String(error));
    }
  }

  async #refresh(): Promise<string> {
    this.#spend();
    let response: Response;
    try {
      const { tokenEndpoint } = await endpointsFor(gmailIssuerFor(this.env));
      response = await fetch(tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: this.credential.refreshToken,
          client_id: this.client.clientId,
          client_secret: this.client.clientSecret,
        }),
      });
    } catch (error) {
      throw new NotAnswering(error instanceof Error ? error.message : String(error));
    }
    // A refresh token revoked, expired or for another client is answered
    // 400 or 401 (`invalid_grant`, `invalid_client`); anything else is Google
    // not answering this time.
    if (response.status === 400 || response.status === 401) {
      throw new SignInRefused(`Google refused to refresh the sign-in: ${response.status}`);
    }
    if (!response.ok) throw new NotAnswering(`Google answered ${response.status} to a refresh`);
    const refreshed = credentialRefreshed(this.credential, await response.json().catch(() => null), this.now);
    if (!refreshed) throw new NotAnswering('Google answered a refresh with no access token');
    await this.keep(refreshed);
    this.credential = refreshed;
    this.#token = refreshed.accessToken;
    return refreshed.accessToken!;
  }

  #spend(): void {
    if (this.calls.left <= 0) throw new OutOfCalls();
    this.calls.left -= 1;
  }
}

function logged(level: 'warn' | 'error', message: string, data?: unknown): void {
  const line = JSON.stringify({ level, connector: 'gmail', message, data });
  if (level === 'error') console.error(line);
  else console.log(line);
}
