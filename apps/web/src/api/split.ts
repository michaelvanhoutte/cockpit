import type { SplitProposal } from '@cockpit/shared';
import { api, refusal } from './client';

/**
 * The cards Claude proposes for *Split* ("Brainstorming: a note holding several
 * ideas can't be taken apart", issue 1828), apart from `client.ts` so it is
 * fetched with the dialog's own chunk rather than in the initial bundle.
 * Null where Claude could not be asked: the dialog then draws one card holding
 * every block, as it does where this request itself fails.
 */
export async function proposeASplit(workspaceId: string, itemId: string, signal?: AbortSignal): Promise<SplitProposal> {
  const res = await api.v1.workspaces[':workspaceId'].items[':itemId']['split-proposal'].$post({ param: { workspaceId, itemId } }, signal ? { init: { signal } } : undefined);
  if (res.status === 401) throw refusal('proposing a split', res.status);
  if (!res.ok) return { cards: null };
  return (await res.json()) as SplitProposal;
}
