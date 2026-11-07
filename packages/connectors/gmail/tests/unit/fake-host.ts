import type {
  CompleteListing,
  ConnectorHost,
  ConversationTurn,
  EmittedItem,
  NamesReport,
  SourceItem,
  SourceStateChange,
} from '@cockpit/connector-sdk';

/**
 * The host as a connector meets it, kept in memory: what it was handed, and the
 * answers a real host gives - `already-known` for a source id it has filed
 * before, one saved state, one credential that `setCredentials` replaces.
 *
 * One instance is one connection. A second run is a second `FakeHost` made
 * `from` the first, so what the first saved is what the second is handed, the
 * way the real host's store carries it between runs.
 */
export class FakeHost implements ConnectorHost {
  choice: string | null;
  state: unknown = null;
  credential: Record<string, string>;
  readonly filed = new Map<string, SourceItem>();
  readonly changes: SourceStateChange[] = [];
  readonly listings: CompleteListing[] = [];
  readonly namesReported: NamesReport[] = [];
  readonly credentialsSaved: Record<string, string>[] = [];
  readonly logged: { level: string; message: string; data?: unknown }[] = [];
  /** Every state this run saved, in order. */
  readonly statesSaved: unknown[] = [];
  /** Every turn reported, in order. */
  readonly turns: ConversationTurn[] = [];
  /** Conversations an open Item already follows, as the host's store holds them. */
  readonly following = new Set<string>();
  /** Conversations whose Item is finished, which the host no longer hands over. */
  readonly finished = new Set<string>();

  constructor(options: { choice?: string | null; credential: Record<string, string> }) {
    this.choice = options.choice === undefined ? 'label' : options.choice;
    this.credential = options.credential;
  }

  /** The next run of the same connection: what this one saved, a clean record of what it is handed. */
  next(): FakeHost {
    const next = new FakeHost({ choice: this.choice, credential: this.credential });
    next.state = this.state;
    for (const [id, item] of this.filed) next.filed.set(id, item);
    for (const id of this.following) next.following.add(id);
    for (const id of this.finished) next.finished.add(id);
    return next;
  }

  async getCredentials(): Promise<Record<string, string>> {
    return this.credential;
  }

  async setCredentials(credentials: Record<string, string>): Promise<void> {
    this.credential = credentials;
    this.credentialsSaved.push(credentials);
  }

  async getState(): Promise<unknown> {
    return this.state === null ? null : structuredClone(this.state);
  }

  async setState(state: unknown): Promise<void> {
    this.state = structuredClone(state);
    this.statesSaved.push(structuredClone(state));
  }

  async emitItem(item: SourceItem): Promise<EmittedItem> {
    const id = item.sourceId ?? '';
    if (this.filed.has(id)) return 'already-known';
    this.filed.set(id, item);
    return 'filed';
  }

  async emitSourceStateChange(change: SourceStateChange): Promise<void> {
    this.changes.push(change);
  }

  async reportCompleteListing(listing: CompleteListing): Promise<void> {
    this.listings.push(listing);
  }

  async reportNames(report: NamesReport): Promise<void> {
    this.namesReported.push({ sourceId: report.sourceId, names: [...report.names] });
  }

  /**
   * The conversations this connection's open Items follow: each one an emitted
   * Item said it follows, as a real host answers, less those a case marks
   * `finished` - plus any a case says the host already holds.
   */
  async followedConversations(): Promise<string[]> {
    const followed = new Set(this.following);
    for (const item of this.filed.values()) if (item.conversation) followed.add(item.conversation.id);
    for (const id of this.finished) followed.delete(id);
    return [...followed];
  }

  async reportTurn(turn: ConversationTurn): Promise<void> {
    this.turns.push(turn);
  }

  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown): void {
    this.logged.push({ level, message, data });
  }

  async sleep(): Promise<void> {}

  /** What was said about one conversation, in order. */
  saidOf(sourceId: string): string[] {
    return this.changes.filter((one) => one.sourceId === sourceId).map((one) => one.change);
  }
}
