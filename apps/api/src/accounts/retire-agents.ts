import { and, count, eq, isNull } from 'drizzle-orm';
import { REMEMBERED_SENTENCES_KEPT, uuidv7 } from '@cockpit/shared';
import { sentenceForAgent, type AgentNotRemembered } from '../domain/agent-sentence.js';
import { CLAUDE_CODE } from '../domain/named-sources.js';
import type { AccountDb } from './client.js';
import { runCommand } from './command-service.js';
import { agents, connectorAccounts, rememberedSentences } from './schema.js';

/**
 * Retiring an account's Agents ("Retire the agents' dock and routines, keeping
 * what each agent knew", issue 1165): each Agent not yet retired becomes one
 * remembered sentence, or is passed over and logged where it cannot
 * (`sentenceForAgent`); and once every Agent of the account is retired, each
 * Claude Code routine connection is disconnected the way Disconnect does it
 * (`disconnect_source_account`), which forgets its credential.
 *
 * **Run by the store after every change has applied, until it has nothing
 * left to do** (`AccountStoreBase`, store.ts), rather than as a change of its
 * own: a change runs once and fails the account's opening when it throws,
 * where this has to pass over a row it cannot convert and be tried again
 * after one that failed. Once done, it finds no Agent and no routine
 * connection, which is two reads.
 *
 * Its failure modes, held by apps/api/tests/integration/accounts/aged-store.test.ts:
 *
 * - **Halfway, and a second run:** each Agent is retired in a transaction of
 *   its own, its sentence and the mark on its row together, and only an
 *   unmarked Agent is read again - so a re-run converts what is left, and an
 *   Agent already converted is never converted twice.
 * - **Interrupted between the sentence and the mark:** a sentence names the
 *   Agent it came from, at most one per Agent (`remembered_sentences_one_per_agent`),
 *   so a re-run that meets one marks the Agent and adds none.
 * - **Rows breaking the rule:** an Agent deleted, with an empty template, an
 *   unknown placeholder, too long, or naming an address or command, becomes
 *   no sentence; it is marked with why and logged, never dropped silently.
 *   The same for an account already holding as many sentences as it keeps.
 * - **A routine connection is disconnected only after its account's Agents
 *   are all retired.** One whose conversion throws is left unmarked and logged,
 *   the connection stays connected, and both are tried again next time.
 */

/** What one pass did, for the store to know whether to try again. */
export interface Retired {
  /** Whether every Agent is retired and every routine connection gone - nothing left for a later pass. */
  done: boolean;
}

export function retireAgents(
  db: AccountDb,
  tenantId: string,
  at: () => string,
  mirroring: readonly string[],
): Retired {
  const waiting = db
    .select({ id: agents.id, name: agents.name, message: agents.message, deletedAt: agents.deletedAt })
    .from(agents)
    .where(and(eq(agents.tenantId, tenantId), isNull(agents.retiredAt)))
    .orderBy(agents.position, agents.createdAt)
    .all();

  let everyAgentRetired = true;
  for (const agent of waiting) {
    try {
      retireOne(db, tenantId, agent, at());
    } catch (error) {
      everyAgentRetired = false;
      log('error', 'an Agent could not be retired, and will be tried again', {
        agentId: agent.id,
        cause: whyItFailed(error),
      });
    }
  }
  if (!everyAgentRetired) return { done: false };

  const routines = db
    .select({ id: connectorAccounts.id, workspaceId: connectorAccounts.workspaceId })
    .from(connectorAccounts)
    .where(and(eq(connectorAccounts.tenantId, tenantId), eq(connectorAccounts.connectorId, CLAUDE_CODE)))
    .all();
  for (const routine of routines) {
    runCommand(
      db,
      tenantId,
      'disconnect_source_account',
      { commandId: uuidv7(), issuedAt: at(), workspaceId: routine.workspaceId, sourceAccountId: routine.id },
      { mirroring },
    );
    log('info', 'a Claude Code routine connection was disconnected, its Agents retired', { sourceAccountId: routine.id });
  }
  return { done: true };
}

function retireOne(
  db: AccountDb,
  tenantId: string,
  agent: { id: string; name: string; message: string; deletedAt: string | null },
  at: string,
): void {
  db.transaction((tx) => {
    const already = tx
      .select({ id: rememberedSentences.id })
      .from(rememberedSentences)
      .where(and(eq(rememberedSentences.tenantId, tenantId), eq(rememberedSentences.agentId, agent.id)))
      .get();
    let becameNone: AgentNotRemembered | 'full' | null = null;
    if (!already) {
      const became = sentenceForAgent({ name: agent.name, message: agent.message, deleted: agent.deletedAt !== null });
      if ('notRemembered' in became) {
        becameNone = became.notRemembered;
      } else if (heldSentences(tx, tenantId) >= REMEMBERED_SENTENCES_KEPT) {
        becameNone = 'full';
      } else {
        tx.insert(rememberedSentences)
          .values({
            id: uuidv7(),
            tenantId,
            // Every Workspace, as an Agent was the account's; for the Items a
            // person captured, which is what an Agent was mostly dropped on.
            workspaceId: null,
            sourceKind: 'internal',
            action: became.action,
            sentence: became.sentence,
            createdAt: at,
            agentId: agent.id,
          })
          .run();
      }
    }
    tx.update(agents)
      .set({ retiredAt: at, retiredAs: becameNone ?? 'sentence' })
      .where(and(eq(agents.tenantId, tenantId), eq(agents.id, agent.id)))
      .run();
    // The id and the reason alone: what an Agent's template says belongs to the person.
    if (becameNone) log('warn', 'an Agent became no remembered sentence', { agentId: agent.id, because: becameNone });
  });
}

function heldSentences(db: Pick<AccountDb, 'select'>, tenantId: string): number {
  return db.select({ n: count() }).from(rememberedSentences).where(eq(rememberedSentences.tenantId, tenantId)).get()?.n ?? 0;
}

/**
 * Why a retirement step failed, without the person's words: a failed query's
 * message carries its SQL and parameters - a sentence, an Agent's template -
 * so only the error's name and the database's own reason are kept.
 */
export function whyItFailed(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown';
  const reason = error.cause instanceof Error ? error.cause.message : error.message;
  return `${error.name}: ${reason.split(/\n|Failed query:/)[0]!.trim() || 'no reason given'}`;
}

function log(level: 'info' | 'warn' | 'error', message: string, data: Record<string, string>): void {
  const line = JSON.stringify({ level, message, data });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.info(line);
}
