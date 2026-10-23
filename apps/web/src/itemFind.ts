import { useMemo } from 'react';
import { indexForFind } from '@cockpit/shared';
import type { Day, FindIndex, WorkspaceSnapshot } from '@cockpit/shared';

/**
 * Find item, the column's second mode ("Find an open Item with F and Shift+F,
 * and land on its row", issue 828). What it matches and where it says an Item
 * is are `@cockpit/shared`'s (`find-item.ts`), which the Worker reads as well;
 * this holds the index in the browser's memory, never with the snapshot.
 */

/** The index of a snapshot, rebuilt only when the snapshot is replaced or the day turns. */
export function useFindIndex(snapshot: WorkspaceSnapshot | undefined, today: Day): FindIndex {
  return useMemo(() => (snapshot ? indexForFind(snapshot, today) : []), [snapshot, today]);
}
