import { useMemo } from 'react';
import { indexForFind, type Day, type FindIndex, type WorkspaceSnapshot } from '@cockpit/shared';

/** The index of a snapshot, rebuilt only when the snapshot is replaced or the day turns. */
export function useFindIndex(snapshot: WorkspaceSnapshot | undefined, today: Day): FindIndex {
  return useMemo(() => (snapshot ? indexForFind(snapshot, today) : []), [snapshot, today]);
}
