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

/** A source-state change observed during sync (tombstones, completions). */
export interface SourceStateChange {
  sourceId: string;
  change: 'resolved' | 'removed';
  observedAt: string;
}

/**
 * Everything the host offers a connector. A connector may use nothing else:
 * no direct database access, no application imports, no global fetch of
 * host endpoints.
 */
export interface ConnectorHost {
  /** Opaque private state per connector+account: cursors, sync bookkeeping. */
  getState(): Promise<unknown>;
  setState(state: unknown): Promise<void>;

  /** Decrypted credentials for the connected account. */
  getCredentials(): Promise<Record<string, string>>;

  /** Normalized output lands here; the host owns persistence and dedup. */
  emitItem(item: SourceItem): Promise<void>;
  emitSourceStateChange(change: SourceStateChange): Promise<void>;

  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown): void;

  /** Rate-limit/backoff helper so connectors don't roll their own. */
  sleep(ms: number): Promise<void>;
}

export interface Connector {
  manifest: ConnectorManifest;

  /** Pull changes from the source. Sync strategy is the connector's private business. */
  sync(host: ConnectorHost): Promise<void>;

  /**
   * Optional push ingress. The host routes POST /ingress/:connectorId/* here
   * verbatim; signature verification is the connector's job.
   */
  handleWebhook?(request: Request, host: ConnectorHost): Promise<Response>;
}
