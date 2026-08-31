import { and, eq } from 'drizzle-orm';
import type { CommandName, CommandPayload, CommandResult } from '@cockpit/shared';
import type { AccountDb } from './client.js';
import { associations, commands, items } from './schema.js';
import { commandAlreadyApplied, getItem, getWorkspace } from './repo.js';
import {
  applySetFocus,
  applySetNextAction,
  applySetPriority,
  applySetStatus,
  applySnoozeUntil,
  associationFromCommand,
  captureItem,
} from '../domain/items.js';

export class ItemNotFoundError extends Error {
  constructor(itemId: string) {
    super(`item ${itemId} not found`);
    this.name = 'ItemNotFoundError';
  }
}

export class WorkspaceNotFoundError extends Error {
  constructor(workspaceId: string) {
    super(`workspace ${workspaceId} not found`);
    this.name = 'WorkspaceNotFoundError';
  }
}

/**
 * The one write path (architecture, "Mutations are commands, not object
 * PUTs"): idempotency check on the client-generated command ID, pure domain
 * handler, then the data change and the command-log entry written inside one
 * transaction of the account's own store.
 *
 * Synchronous throughout, and deliberately: `db.transaction` on a Durable
 * Object's SQLite is `ctx.storage.transactionSync`, which commits when its
 * callback returns. An `await` inside it would commit the transaction before
 * the work it wraps had happened. See `client.ts`.
 */
export function runCommand<N extends CommandName>(
  db: AccountDb,
  tenantId: string,
  name: N,
  payload: CommandPayload<N>,
): CommandResult {
  if (commandAlreadyApplied(db, payload.commandId)) {
    return { ok: true, applied: false };
  }

  const commandRow = {
    commandId: payload.commandId,
    tenantId,
    workspaceId: payload.workspaceId,
    name,
    payload: JSON.stringify(payload),
    issuedAt: payload.issuedAt,
    receivedAt: new Date().toISOString(),
  };

  let applied = true;

  switch (name) {
    case 'capture_item': {
      const cmd = payload as CommandPayload<'capture_item'>;
      // The workspace is client-supplied and only shape-validated, so this is
      // the one place an unknown id can reach a write. Checked here rather
      // than left to the foreign key: the constraint would surface a caller's
      // mistake as a 500, and this is a 404 like any other missing thing.
      if (!getWorkspace(db, tenantId, cmd.workspaceId)) {
        throw new WorkspaceNotFoundError(cmd.workspaceId);
      }
      const item = captureItem(cmd, tenantId);
      db.transaction((tx) => {
        // A retried capture whose command ID was lost still may not duplicate the item.
        tx.insert(items).values(item).onConflictDoNothing().run();
        tx.insert(commands).values(commandRow).run();
      });
      break;
    }
    case 'associate': {
      const cmd = payload as CommandPayload<'associate'>;
      const existing = getItem(db, tenantId, cmd.itemId);
      if (!existing) throw new ItemNotFoundError(cmd.itemId);
      db.transaction((tx) => {
        if (cmd.remove) {
          tx.delete(associations)
            .where(and(eq(associations.tenantId, tenantId), eq(associations.id, cmd.associationId)))
            .run();
        } else {
          tx.insert(associations)
            .values(associationFromCommand(cmd, tenantId))
            .onConflictDoNothing()
            .run();
        }
        tx.insert(commands).values(commandRow).run();
      });
      break;
    }
    default: {
      // All remaining commands are updates to a single existing item.
      const cmd = payload as
        | CommandPayload<'set_status'>
        | CommandPayload<'snooze_until'>
        | CommandPayload<'set_focus'>
        | CommandPayload<'set_next_action'>
        | CommandPayload<'set_priority'>;
      const existing = getItem(db, tenantId, cmd.itemId);
      if (!existing) throw new ItemNotFoundError(cmd.itemId);

      const updated =
        name === 'set_status'
          ? applySetStatus(existing, cmd as CommandPayload<'set_status'>)
          : name === 'snooze_until'
            ? applySnoozeUntil(existing, cmd as CommandPayload<'snooze_until'>)
            : name === 'set_focus'
              ? applySetFocus(existing, cmd as CommandPayload<'set_focus'>)
              : name === 'set_next_action'
                ? applySetNextAction(existing, cmd as CommandPayload<'set_next_action'>)
                : applySetPriority(existing, cmd as CommandPayload<'set_priority'>);

      if (updated === null) {
        // Stale by last-write-wins: log the command, change nothing.
        db.insert(commands).values(commandRow).run();
        applied = false;
      } else {
        db.transaction((tx) => {
          tx.update(items)
            .set(updated)
            .where(and(eq(items.tenantId, tenantId), eq(items.id, cmd.itemId)))
            .run();
          tx.insert(commands).values(commandRow).run();
        });
      }
      break;
    }
  }

  // No explicit broadcast: SSE connections derive invalidations from the
  // command log itself (see events.ts for why in-memory fan-out can't work).
  return { ok: true, applied };
}
