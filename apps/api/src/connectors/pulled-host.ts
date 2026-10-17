import {
  SourceError,
  type CompleteListing,
  type Connector,
  type ConnectorHost,
  type EmittedItem,
  type NamesReport,
  type SourceItem,
  type SourceStateChange,
} from '@cockpit/connector-sdk';
import type { Env } from '../env.js';
import {
  AccountNotInRegisterError,
  openAccount,
  type Account,
  type PulledRun,
} from '../accounts/index.js';
import type { PulledRunStarted } from '../accounts/pulled.js';
import { open, seal, sealingKey, type Sealed } from './credential-crypto.js';
import { derivedUuid } from './push-host.js';
import { getConnector } from './registry.js';
import type { CheckDid } from '../domain/connection-history.js';

/**
 * The generic host a connector Cockpit pulls from is run through ("Check a
 * pulled connector on its cadence through the generic host", issue 891): one
 * queued check of one connection, run here in the Worker and calling back into
 * the account's store for everything it reads and writes.
 *
 * **The account's store keeps the clock; the Worker does the work.** The
 * store's alarm queues `check-a-pulled-connection` naming the account and the
 * connection; this takes the connection's lease, opens its credential - which
 * the store never does, the key being the Worker's - runs `sync`, and gives the
 * lease back with the next check five minutes on - or soon, where `sync`
 * answered that there is more to do ("Check a pulled connector again soon when
 * its run says there is more to do", issue 957).
 *
 * **Every call is safe to repeat.** An Item's ids derive from the connection
 * and the source id, so emitting it again is already known; private state is
 * saved only when the connector saves it; so a run that dies is re-read from
 * the last saved point next time, losing nothing.
 */

/**
 * One delivered check. A decision - nobody's account, a run already under
 * way, a check already run - ends quietly; taking or giving back the lease
 * failing is thrown to the queue's retry. Anything thrown during `sync`, the
 * connector's own calls back into the store among it, is a check that failed,
 * which the connection's row says, and is not retried before its turn.
 *
 * `filed` is what an Item newly filed asks for - the jobs capture's own route
 * queues - handed in by the queue consumer, since a connector may not import
 * the jobs it runs under - told which connector filed it, for the record of
 * the call its clean-up makes.
 */
export async function checkPulledConnection(
  env: Env,
  job: { accountName: string; sourceAccountId: string },
  filed: (accountName: string, itemId: string, connectorId: string) => Promise<void>,
): Promise<void> {
  let account: Account;
  try {
    account = await openAccount(env, job.accountName);
  } catch (error) {
    if (error instanceof AccountNotInRegisterError) return;
    throw error;
  }
  const begun = await account.beginPulledRun(job.sourceAccountId);
  if (begun.status !== 'started') return;

  const run = account.pulledRun(job.sourceAccountId, begun.runId);
  const connector = getConnector(env, begun.connectorId);
  let failing: string | null = null;
  let status: number | undefined;
  let moreToDo = false;
  // What the connector's calls through the host did, for the check's line of the history (issue 1141).
  const did: CheckDid = { broughtIn: [], closed: [], sentBack: [], refused: [] };
  try {
    if (!connector?.manifest.pulled) {
      throw new Error(`this version of Cockpit does not check ${begun.connectorId}`);
    }
    const host = pulledHost(env, begun, run, did, connector.manifest.names !== undefined, (itemId) =>
      filed(job.accountName, itemId, begun.connectorId),
    );
    // Before the source is read, so a change a person made that it has not
    // heard yet is pushed first and wins over what the read finds. A push that
    // fails does not stop the read - what waits still wins over it - but is
    // the run's failure once the read is done.
    const pushFailed = await mirrorWhatWasChanged(connector, begun.connectorId, host, run, did).then(
      () => null,
      (error: unknown) => ({ error }),
    );
    const answer = await connector.sync(host);
    moreToDo = answer?.moreToDo === true;
    if (pushFailed) throw pushFailed.error;
  } catch (error) {
    failing = error instanceof Error ? error.message : String(error);
    // The source's own status, where the connector gave one (issue 1142).
    if (error instanceof SourceError) status = error.status;
    logged(begun.connectorId, 'error', `a check of connection ${job.sourceAccountId} failed`, failing);
  }
  await run.end(failing, moreToDo, did, status);
}

/**
 * Hands a connector that mirrors open state every one still waiting, and
 * stops waiting for those it confirms and for those it gives up on, logging
 * each give-up as a refusal; the rest are handed again next run ("Mirror an
 * Item's open state back to a pulled source through the generic host", issue
 * 893; "Let a pulled connector give up on an open state its source refuses for
 * good", issue 940). A source id the connector names that was not handed is
 * ignored, and an answer from a run that no longer holds its connection is
 * refused, every change staying waiting.
 */
async function mirrorWhatWasChanged(
  connector: Connector,
  connectorId: string,
  host: ConnectorHost,
  run: PulledRun,
  did: CheckDid,
): Promise<void> {
  if (!connector.manifest.mirrorsOpenState || !connector.mirrorOpenState) return;
  const wanted = await run.openStatesWaiting();
  if (wanted.length === 0) return;
  const answer = await connector.mirrorOpenState(host, wanted);
  const { confirmed = [], gaveUp = [] } = Array.isArray(answer) ? { confirmed: answer } : answer;
  const named = (ids: readonly string[]) => {
    const set = new Set(ids);
    return wanted.filter((one) => set.has(one.sourceId));
  };
  const held = named(confirmed);
  // An id named both ways is confirmed: the source holds it, so nothing was refused.
  const refused = named(gaveUp).filter((one) => !held.includes(one));
  // A give-up clears exactly as a confirmation does; it is logged only where
  // it cleared, since a run that lost its connection cleared nothing.
  const cleared = await run.confirmOpenStates([...held, ...refused]);
  if (cleared === 'not this run') return;
  // Counted as the store cleared them, so a change a person made again while
  // the connector pushed, which stays waiting, is not counted as sent back.
  const refusedIds = new Set(refused.map((one) => one.sourceId));
  for (const { sourceId, itemId } of cleared.cleared) {
    (refusedIds.has(sourceId) ? did.refused : did.sentBack).push(itemId);
  }
  for (const one of refused) {
    logged(
      connectorId,
      'warn',
      `the source refused to ${one.open ? 'open' : 'close'} ${one.sourceId} for good; gave up on it`,
      { sourceId: one.sourceId, open: one.open },
    );
  }
}

/** What a connector may do with the one connection this run holds. */
function pulledHost(
  env: Env,
  begun: PulledRunStarted,
  run: PulledRun,
  did: CheckDid,
  reportsNames: boolean,
  filed: (itemId: string) => Promise<void>,
): ConnectorHost {
  const { connectorId } = begun;
  /** The sealed credential this run opened, and what it opened to - the latest rotated one, once there is one. */
  let opened: { sealed: Sealed; credential: string } | null = null;

  return {
    choice: begun.choice,

    log: (level, message, data) => logged(connectorId, level, message, data),

    getState: () => run.state(),

    async setState(state: unknown): Promise<void> {
      await run.saveState(state);
    },

    /**
     * The credential of this one connection, opened here rather than in the
     * store (docs/architecture.md, "Connectors: plugin-shaped, host-blind").
     */
    async getCredentials(): Promise<Record<string, string>> {
      if (opened) return { credential: opened.credential };
      const key = await keyOf(env);
      const sealed = await run.sealedCredential();
      if (!sealed) throw new Error('the connection this check was for has been disconnected');
      const credential = await open(sealed, key);
      if (credential === null) {
        throw new Error("the stored credential could not be opened with this environment's key");
      }
      opened = { sealed, credential };
      return { credential };
    },

    /**
     * A credential the source rotated, sealed here and saved only while the
     * stored one is still what this run opened: a reconnect made meanwhile
     * keeps its own, whole.
     */
    async setCredentials(credentials: Record<string, string>): Promise<void> {
      const credential = credentials.credential;
      if (!credential) throw new Error(`the ${connectorId} connector handed back a credential with nothing in it`);
      const key = await keyOf(env);
      const was = opened?.sealed ?? (await run.sealedCredential());
      if (!was) return;
      const sealed = await seal(credential, key);
      if ((await run.reseal(was, sealed)) === 'saved') opened = { sealed, credential };
    },

    /**
     * Files what the connector read as an Item of the connection's Workspace,
     * once per source id, and asks for the two jobs capture's own route asks
     * for - only where the Item was filed, so a re-read buys no second model
     * call. An item the source cannot name is refused, as the push host
     * refuses one (`push-host.ts`).
     */
    async emitItem(item: SourceItem): Promise<EmittedItem> {
      const sourceId = item.sourceId ?? '';
      if (!sourceId) throw new Error(`the ${connectorId} connector emitted an item its source does not name`);
      // As a JSON array rather than joined, since an account's key may itself
      // hold the separator (Teams' `tenant:user`) and two pairs must never
      // name one Item.
      const named = JSON.stringify([begun.workspaceId, connectorId, begun.externalAccountKey, sourceId]);
      const itemId = await derivedUuid(`pulled-item:${named}`);
      // Names only from a connector that declares it reports them (issue 1146).
      const { names, ...rest } = item;
      const { followed, ...itemRest } = rest;
      const { answer, named: namedOn } = await run.fileItem(
        {
          ...itemRest,
          sourceId,
          ...(reportsNames && names ? { names: [...names] } : {}),
          ...(reportsNames && names && followed ? { followed } : {}),
        },
        { itemId, commandId: await derivedUuid(`pulled-capture:${named}`) },
      );
      if (namedOn) (did.named ??= []).push(namedOn);
      // Disconnected meanwhile: nothing was filed, and nothing is asked of
      // the connector - the run ends with whatever it does next.
      if (answer !== 'filed') return 'already-known';
      did.broughtIn.push(itemId);
      await filed(itemId);
      return 'filed';
    },

    async emitSourceStateChange(change: SourceStateChange): Promise<void> {
      const applied = await run.applySourceChange(change);
      if (typeof applied === 'object' && change.change === 'resolved') did.closed.push(applied.changed);
    },

    async reportCompleteListing(listing: CompleteListing): Promise<void> {
      const closed = await run.closeItemsNotListed(listing);
      if (closed !== 'disconnected') did.closed.push(...closed);
      // What the check's line says it listed (issue 1196): the host already holds the whole listing.
      did.listed = new Set(listing.sourceIds).size;
    },

    /**
     * An Item's names as the source holds them now, recorded on its link and
     * filed by in the store (issue 1146). Taken only from a connector that
     * declares it reports names, whatever another sends.
     */
    async reportNames(report: NamesReport): Promise<void> {
      if (!reportsNames) return;
      const { named } = await run.reportNames({
        sourceId: report.sourceId,
        names: [...report.names],
        ...(report.followed ? { followed: report.followed } : {}),
      });
      if (named) (did.named ??= []).push(named);
    },

    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

async function keyOf(env: Env): Promise<CryptoKey> {
  const key = await sealingKey(env.CONNECTOR_CREDENTIAL_KEY);
  if (!key) throw new Error('this environment has no key to open a stored credential with');
  return key;
}

function logged(
  connectorId: string,
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  data?: unknown,
): void {
  const line = JSON.stringify({ level, connector: connectorId, message, data });
  if (level === 'error') console.error(line);
  else console.log(line);
}
