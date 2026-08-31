import { and, eq } from 'drizzle-orm';
import type { CommandName, CommandPayload, CommandResult } from '@cockpit/shared';
import type { Db } from '../db/client.js';
import { associations, commands, items, workspaces } from '../db/schema.js';
import {
  commandAlreadyApplied,
  getItem,
  getWorkspace,
  listWorkspaces,
} from '../db/repo.js';
import {
  foldName,
  nextColor,
  workspaceFromCommand,
  workspaceNamed,
} from '../domain/workspaces.js';
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

export class WorkspaceNotFoundError extends Error {
  constructor(workspaceId: string) {
    super(`workspace ${workspaceId} not found`);
  }
}

export class WorkspaceNameTakenError extends Error {
  constructor(name: string) {
    super(`a workspace called ${name} already exists`);
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
    case 'create_workspace': {
      const cmd = payload as CommandPayload<'create_workspace'>;
      // One list, two questions: which colors are taken, and whether the name
      // is. The color is a function of the whole set, so it is picked here
      // rather than by the client, whose copy of that set can be stale.
      const existing = await listWorkspaces(db, tenantId);
      // `workspaceNamed` is the one place a name is compared, for creating and
      // for renaming alike, and its own comment says why it folds the names it
      // is handed rather than reading the folded column.
      const alreadyCalledThat = workspaceNamed(existing, cmd.name);
      if (alreadyCalledThat) throw new WorkspaceNameTakenError(alreadyCalledThat.name);
      const workspace = workspaceFromCommand(cmd, tenantId, nextColor(existing.map((w) => w.color)));
      // A retried create whose command ID was lost still may not make a second
      // workspace: the id is the client's, so the replay carries the same one.
      //
      // `target` is load-bearing, and this is the one table where leaving it
      // off is dangerous. Bare `onConflictDoNothing()` means *any* conflict,
      // and workspaces now carry a second unique index - the one on the name.
      // Two creates of the same name racing past the check above would then
      // both answer "done" while the second wrote nothing at all: the box
      // clears, the list is re-read, and the workspace is simply not there.
      // Named at the primary key, the id replay stays a no-op and a name
      // collision raises, which is what the index is for. (`items` and
      // `associations` have no second unique index, so their bare calls below
      // mean only what they say.)
      await db.batch([
        db.insert(workspaces).values(workspace).onConflictDoNothing({ target: workspaces.id }),
        logCommand,
      ]);
      break;
    }
    case 'rename_workspace': {
      const cmd = payload as CommandPayload<'rename_workspace'>;
      // One list, two questions again: is this workspace still there, and is
      // the name free. Live only, so renaming a workspace that is no longer
      // there is a 404 rather than an update that quietly matches no rows.
      const existing = await listWorkspaces(db, tenantId);
      if (!existing.some((w) => w.id === cmd.workspaceId)) {
        throw new WorkspaceNotFoundError(cmd.workspaceId);
      }
      // The same question creating asks, minus this workspace's own row: the
      // name it already has, in any capitalization, collides with nothing.
      const alreadyCalledThat = workspaceNamed(existing, cmd.name, cmd.workspaceId);
      if (alreadyCalledThat) throw new WorkspaceNameTakenError(alreadyCalledThat.name);
      await db.batch([
        db
          .update(workspaces)
          // `foldedName` alongside `name`, never on its own and never left
          // behind: it is what the unique index holds, so a rename that wrote
          // only the name would leave the index guarding the old one - the
          // workspace would still block its previous name and stop blocking
          // its current one.
          .set({ name: cmd.name, foldedName: foldName(cmd.name) })
          .where(and(eq(workspaces.tenantId, tenantId), eq(workspaces.id, cmd.workspaceId))),
        logCommand,
      ]);
      break;
    }
    case 'delete_workspace': {
      const cmd = payload as CommandPayload<'delete_workspace'>;
      // A workspace already deleted is not there to delete again, so the same
      // delete sent twice deletes one workspace whether the replay carries the
      // original request id (caught above) or a fresh one (caught here).
      if (!(await getWorkspace(db, tenantId, cmd.workspaceId))) {
        throw new WorkspaceNotFoundError(cmd.workspaceId);
      }
      // A tombstone, not a delete: the items stay exactly where they are, so
      // the router keeps the history of where things were actually filed.
      // `issuedAt` is the client's own clock, like every other timestamp a
      // command writes, so a delete queued offline records when it was made.
      await db.batch([
        db
          .update(workspaces)
          .set({ deletedAt: cmd.issuedAt })
          .where(and(eq(workspaces.tenantId, tenantId), eq(workspaces.id, cmd.workspaceId))),
        logCommand,
      ]);
      break;
    }
    case 'capture_item': {
      const cmd = payload as CommandPayload<'capture_item'>;
      // The workspace is client-supplied and only shape-validated, so this is
      // the one place an unknown id can reach a write. Checked here rather
      // than left to the foreign key: the constraint would surface a caller's
      // mistake as a 500, and this is a 404 like any other missing thing.
      if (!(await getWorkspace(db, tenantId, cmd.workspaceId))) {
        throw new WorkspaceNotFoundError(cmd.workspaceId);
      }
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
