import { and, eq } from 'drizzle-orm';
import type { CommandName, CommandPayload, CommandResult } from '@cockpit/shared';
import type { Db } from '../db/client.js';
import { associations, commands, items } from '../db/schema.js';
import { commandAlreadyApplied, getItem } from '../db/repo.js';
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
  }
}

/**
 * The one write path (architecture §4.3): idempotency check on the
 * client-generated command ID, pure domain handler, then the data change and
 * the command-log entry written in a single D1 batch (atomic).
 */
export async function runCommand<N extends CommandName>(
  db: Db,
  tenantId: string,
  name: N,
  payload: CommandPayload<N>,
): Promise<CommandResult> {
  if (await commandAlreadyApplied(db, payload.commandId)) {
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
  const logCommand = db.insert(commands).values(commandRow);

  let applied = true;

  switch (name) {
    case 'capture_item': {
      const cmd = payload as CommandPayload<'capture_item'>;
      const item = captureItem(cmd, tenantId);
      // A retried capture whose command ID was lost still may not duplicate the item.
      await db.batch([db.insert(items).values(item).onConflictDoNothing(), logCommand]);
      break;
    }
    case 'associate': {
      const cmd = payload as CommandPayload<'associate'>;
      const existing = await getItem(db, tenantId, cmd.itemId);
      if (!existing) throw new ItemNotFoundError(cmd.itemId);
      const write = cmd.remove
        ? db
            .delete(associations)
            .where(
              and(eq(associations.tenantId, tenantId), eq(associations.id, cmd.associationId)),
            )
        : db.insert(associations).values(associationFromCommand(cmd, tenantId)).onConflictDoNothing();
      await db.batch([write, logCommand]);
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
      const existing = await getItem(db, tenantId, cmd.itemId);
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
        await db.batch([logCommand]);
        applied = false;
      } else {
        await db.batch([
          db
            .update(items)
            .set(updated)
            .where(and(eq(items.tenantId, tenantId), eq(items.id, cmd.itemId))),
          logCommand,
        ]);
      }
      break;
    }
  }

  // No explicit broadcast: SSE connections derive invalidations from the
  // command log itself (see events.ts for why in-memory fan-out can't work).
  return { ok: true, applied };
}
