import { queryOptions } from '@tanstack/react-query';
import { rememberedSentenceListSchema } from '@cockpit/shared';
import { api, refusal } from './api/client';

/**
 * The account's remembered sentences ("See and change what Cockpit remembers",
 * issue 1164), read by Settings to list and by the review window to name those
 * a proposal learned from. Its own module so the window's chunk does not carry
 * Settings' section (`bundle:budget`).
 */
export const rememberedSentencesQuery = queryOptions({
  queryKey: ['rememberedSentences'],
  queryFn: async () => {
    const res = await api.v1['remembered-sentences'].$get();
    if (!res.ok) throw refusal('remembered sentences', res.status);
    return rememberedSentenceListSchema.parse(await res.json());
  },
  // What is kept *now*: a sentence may have been changed from another tab.
  staleTime: 0,
});
