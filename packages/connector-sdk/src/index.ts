import type { Item, Source } from '@cockpit/shared';

/**
 * The connector SPI (architecture §6.2). Two-sided contract:
 * - a connector package implements `Connector` and may import ONLY this SDK;
 * - the host (apps/api) implements `ConnectorHost` and knows connectors only
 *   as a list of registrations in one composition-root file.
 *
 * Interface test for any addition here: would this method exist if one
 * particular source didn't? If not, it stays inside that connector.
 */

export interface ConnectorManifest {
  id: string;
  displayName: string;
  source: Source;
  /** Whether the source can push (webhooks) in addition to being pulled. */
  supportsPush: boolean;
  auth: OAuthDescriptor | { kind: 'none' };
}

/** Enough for the host to run the OAuth dance generically. */
export interface OAuthDescriptor {
  kind: 'oauth2';
  authorizationUrl: string;
  tokenUrl: string;
  scopes: string[];
}

/**
 * What a connector is allowed to produce for an Item: the source-owned slice,
 * plus the two texts a source only ever *seeds*. `capturedMessage` is written
 * once when the Item is made and `title` is app-owned from that moment on
 * (architecture, "Schema conventions"), so a later sync proposing either
 * changes nothing already stored - which is what lets somebody rename an Item
 * and keep the name. App-owned fields (status, focus, associations, ...) are
 * never a connector's business; the host merges these into full Items per the
 * reconciliation rule.
 */
export type SourceItem = Pick<
  Item,
  | 'source'
  | 'sourceId'
  | 'sourceLink'
  | 'sender'
  | 'sourceTimestamp'
  | 'title'
  | 'capturedMessage'
>;

/** What the host did with an emitted item: `filed` as a new Item, or `already-known` and left as it was. */
export type EmittedItem = 'filed' | 'already-known';

/** A source-state change observed during sync (tombstones, completions). */
export interface SourceStateChange {
  sourceId: string;
  change: 'resolved' | 'removed';
  observedAt: string;
}

/**
 * What the host offers once it knows *whose* connection this is - the slice a
 * push gets, and the slice a sync gets on top of its own.
 *
 * Nothing here is reachable before that: a connection is what an account's
 * credential is sealed under, so handing any of it out unattributed would be
 * opening one account's secret on another account's say-so.
 */
export interface ConnectedAccountHost {
  /**
   * Decrypted credentials for this one connected account, opened on the first
   * call and never before ("Save a Teams message to Cockpit", issue 486).
   */
  getCredentials(): Promise<Record<string, string>>;

  /**
   * Normalized output lands here; the host owns persistence and dedup. Says
   * whether the item was filed as a new Item or was already known, which a push
   * connector needs to tell whoever sent it what became of it.
   */
  emitItem(item: SourceItem): Promise<EmittedItem>;

  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown): void;
}

/**
 * Everything the host offers a connector pulling from a source. A connector may
 * use nothing else: no direct database access, no application imports, no
 * global fetch of host endpoints.
 */
export interface ConnectorHost extends ConnectedAccountHost {
  /** Opaque private state per connector+account: cursors, sync bookkeeping. */
  getState(): Promise<unknown>;
  setState(state: unknown): Promise<void>;

  emitSourceStateChange(change: SourceStateChange): Promise<void>;

  /** Rate-limit/backoff helper so connectors don't roll their own. */
  sleep(ms: number): Promise<void>;
}

/**
 * What the host offers a connector handling a push, *before* it knows whose
 * push it is ("Save a Teams message to Cockpit", issue 486).
 *
 * **One inbound address serves every connected account of a source**, and
 * nothing in the delivery is the host's to read: the connector is what proves
 * the call genuine and what says, in the source's own terms, which account it
 * names. So the step between the two halves is here rather than in any one
 * connector - a push-based connector after this one resolves its account the
 * same way rather than inventing the step again.
 *
 * Generic by the SDK's own test: a shared address that has to be attributed
 * before it can be acted on is a property of being pushed to, not of Teams.
 */
export interface PushHost {
  /**
   * The connection this account at the source belongs to, or `null` where no
   * Workspace has connected it.
   *
   * `externalAccountKey` is the same key the connection was stored under when
   * somebody connected the account, in the source's own terms - a plain
   * identifier, compared against plain identifiers. **Nothing account-scoped
   * exists until this has answered**, which is what keeps a push that matches
   * nothing from ever reaching a stored credential.
   */
  forAccount(externalAccountKey: string): Promise<ConnectedAccountHost | null>;

  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown): void;
}

export interface Connector {
  manifest: ConnectorManifest;

  /** Pull changes from the source. Sync strategy is the connector's private business. */
  sync(host: ConnectorHost): Promise<void>;

  /**
   * Optional push ingress. The host routes POST /ingress/:connectorId/* here
   * verbatim; proving the call genuine is the connector's job, and so is the
   * Response, every source expecting its own acknowledgement.
   *
   * The host it is handed knows no account yet: `host.forAccount` is how the
   * connector turns the identity it read out of a verified call into the one
   * connection this push belongs to.
   */
  handleWebhook?(request: Request, host: PushHost): Promise<Response>;
}
