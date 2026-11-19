import { useCallback, useEffect } from 'react';
import type { Checkable } from './checkConnections';
import { dismissCheckNote, listedNow, pressCheck, useCheckState } from './checkRuns';

/**
 * The Inbox's ↻ ("Inbox: mail you just labelled waits for the five-minute check, or a Check now per connection in Settings: add a ↻ to the Inbox heading that checks them all now", issue 1835): `press` asks the server to check every pulled connection of the Workspace and `checking` is true until each has said its check ended. The press itself is held in `checkRuns.ts`, so it survives the heading being drawn again.
 */
export function useCheckConnections(workspaceId: string, checkable: readonly Checkable[]) {
  const { checking, note } = useCheckState(workspaceId);
  const press = useCallback(() => pressCheck(workspaceId, checkable), [workspaceId, checkable]);
  const dismiss = useCallback(() => dismissCheckNote(workspaceId), [workspaceId]);
  useEffect(() => listedNow(workspaceId, checkable), [workspaceId, checkable]);
  return { press, dismiss, checking, note };
}
