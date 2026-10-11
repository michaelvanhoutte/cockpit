/**
 * What connecting a source changes ("Connect a Microsoft Teams source
 * account", issue 485). Pure, like `agents.ts` beside this: decided from the
 * connection the Workspace already holds for that account, which the store
 * loads, and written by the store.
 */

/** The connection this Workspace already holds for the account being connected, as the store loaded it. */
export interface HeldConnection {
  id: string;
  /** The one choice it was made under, null when it asked none. */
  choice: string | null;
  /** Whether a failure is recorded against it. */
  failing: boolean;
}

export interface SourceConnectionFacts {
  /** Undefined when this account is not yet connected in the Workspace. */
  held: HeldConnection | undefined;
}

/** What the connect asked, reduced to what the decision reads. */
export interface SourceConnection {
  sourceAccountId: string;
  /** Absent when the connector asks nothing, or a reconnect asked nothing. */
  choice: string | undefined;
  issuedAt: string;
}

/** What the store writes for a connect. */
export interface SourceConnectionDecided {
  /** A new row, or the one already there refreshed - never a second. */
  connection: 'new' | 'refreshed';
  /** The row's id: the one it has always had on a refresh. */
  accountId: string;
  /** The choice to write on a refresh; undefined leaves the stored one. */
  choiceOnRefresh: string | undefined;
  /** Whether what was waiting for the source is dropped, as changing the choice drops it. */
  dropWaiting: boolean;
  /** Whether whatever said it was failing ends. */
  clearFailure: boolean;
  /** When its next check is due: now. */
  nextCheckDueAt: string;
}

/** Decides what connecting an account changes. */
export function decideSourceConnection(
  facts: SourceConnectionFacts,
  connect: SourceConnection,
): SourceConnectionDecided {
  const { held } = facts;
  return {
    connection: held ? 'refreshed' : 'new',
    accountId: held ? held.id : connect.sourceAccountId,
    choiceOnRefresh: connect.choice,
    dropWaiting: connect.choice !== undefined && held !== undefined && held.choice !== connect.choice,
    clearFailure: held?.failing ?? false,
    nextCheckDueAt: connect.issuedAt,
  };
}
