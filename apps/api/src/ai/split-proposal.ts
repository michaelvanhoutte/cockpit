import { splitBlocksOf, type SplitProposal } from '@cockpit/shared';
import { NotFoundInAccountError, type Account } from '../accounts/index.js';
import { GUEST_ACCOUNT_NAME } from '../accounts/new-user.js';
import type { Env } from '../env.js';
import { aiFor } from './index.js';

/**
 * The cards Claude proposes for Split ("Brainstorming: a note holding several
 * ideas can't be taken apart", issue 1828), asked for while the dialog is open
 * on blocks it has already drawn. **The Item is read here, from the store, never
 * taken from the request**: what is sent to Claude is what the account holds,
 * and the blocks are the ones the dialog drew (`splitBlocksOf`).
 *
 * `cards` is null, one card holding every block in the dialog, where the guest
 * asks (the shared demo never spends the key), where there is no key, where the
 * Item has no block to propose from, or where the call fails, runs past its
 * cut-off or answers nothing usable. None of these is an error: Split still
 * works, by hand.
 */
export async function proposeASplit(env: Env, account: Account, accountName: string, workspaceId: string, itemId: string): Promise<SplitProposal> {
  const sources = await account.splitSources(itemId);
  // Another Workspace's Item is not one this Workspace can name, as on a Panel.
  if (!sources || (sources.workspaceDecided && sources.workspaceId !== workspaceId)) throw new NotFoundInAccountError(`item ${itemId} not found`);
  const blocks = splitBlocksOf(sources, sources.additions, sources.attachments);
  const ai = accountName === GUEST_ACCOUNT_NAME || blocks.length < 2 ? null : aiFor(env);
  if (!ai) return { cards: null };
  try {
    const proposed = await ai.proposeASplit({ title: sources.title, blocks }, { accountName, itemId, triggeredBy: 'split-in-app' });
    if ('discarded' in proposed) {
      console.log(JSON.stringify({ level: 'warn', message: 'Claude proposed no split', data: proposed.discarded }));
      return { cards: null };
    }
    return { cards: proposed.cards };
  } catch (error) {
    console.log(JSON.stringify({ level: 'warn', message: 'Claude could not propose a split', data: error instanceof Error ? error.message : String(error) }));
    return { cards: null };
  }
}
