import { and, gt } from 'drizzle-orm';
import { eq } from 'drizzle-orm';
import type { ServerEvent } from '@cockpit/shared';
import type { Db } from '../db/client.js';
import { commands } from '../db/schema.js';

/**
 * SSE invalidation source (architecture §5.2, amended by reality): a
 * module-level in-memory bus does NOT work on the Workers runtime, because
 * one request context may not write to another request's response stream
 * ("Cannot perform I/O on behalf of a different request"). Instead, each SSE
 * connection polls the command log — which every write already lands in for
 * idempotency (§4.3) — from inside its own request context. The wire contract
 * is unchanged; a Durable Object replaces these internals if polling ever
 * costs too much.
 */
export async function collectInvalidations(
  db: Db,
  tenantId: string,
  since: string,
): Promise<{ events: ServerEvent[]; cursor: string }> {
  const rows = await db
    .select({ workspaceId: commands.workspaceId, receivedAt: commands.receivedAt })
    .from(commands)
    .where(and(eq(commands.tenantId, tenantId), gt(commands.receivedAt, since)));

  let cursor = since;
  const workspaceIds = new Set<string>();
  for (const row of rows) {
    workspaceIds.add(row.workspaceId);
    if (row.receivedAt > cursor) cursor = row.receivedAt;
  }

  const events: ServerEvent[] = [...workspaceIds].map((workspaceId) => ({
    type: 'snapshot_invalidated',
    workspaceId,
  }));
  return { events, cursor };
}
