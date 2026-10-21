import { useCallback, useMemo } from 'react';
import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';
import { rememberedSentenceListSchema, type CommandResult, type RememberedSentenceList, type WorkspaceList } from '@cockpit/shared';
import { api, refusal } from './api/client';
import { changeList, readBegins, useDrawnOver } from './api/ownList';
import type { CommandArgs } from './api/queries';
import { sentencesDrawnOver } from './rememberedSentencesDrawnAhead';

/**
 * The account's remembered sentences ("See and change what Cockpit remembers",
 * issue 1164), read by Settings to list and by the review window to name those
 * a proposal learned from, and the changes made to them ("Show a
 * remembered-sentence change the moment you make it", issue 1370). Its own
 * module so the window's chunk does not carry Settings' section, nor the
 * initial bundle any of this (`bundle:budget`). Drawn and read as
 * `api/ownList.ts` does for every window's list.
 */

export const rememberedSentencesQuery = queryOptions({
  queryKey: ['rememberedSentences'],
  queryFn: async ({ client, queryKey }) => {
    readBegins(client, queryKey);
    const res = await api.v1['remembered-sentences'].$get();
    if (!res.ok) throw refusal('remembered sentences', res.status);
    return rememberedSentenceListSchema.parse(await res.json());
  },
  // What is kept *now*: a sentence may have been changed from another tab.
  staleTime: 0,
});

/**
 * The sentences as the window draws them: the list the server sent, with this
 * tab's changes not yet covered by a read of it laid over (`changeQueue.ts`).
 */
export function useRememberedSentences() {
  const client = useQueryClient();
  const over = useMemo(() => {
    const nameOf = (workspaceId: string) =>
      client.getQueryData<WorkspaceList>(['workspaces'])?.workspaces.find((one) => one.id === workspaceId)?.name;
    return sentencesDrawnOver(nameOf);
  }, [client]);
  const select = useDrawnOver<RememberedSentenceList>(over);
  return useQuery({ ...rememberedSentencesQuery, select });
}

/**
 * Sends a sentence change - kept, reworded or forgotten. It joins the tab's
 * queue and is drawn at once (`useRememberedSentences`); it settles with the
 * server's answer, or its refusal, which the caller says. **The list is read
 * once the queue has emptied**, not waited for, and no Workspace is read at all.
 */
export function useChangeSentence(): (args: CommandArgs) => Promise<CommandResult> {
  const client = useQueryClient();
  return useCallback((args) => changeList(client, rememberedSentencesQuery.queryKey, args), [client]);
}
