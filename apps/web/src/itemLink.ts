import { itemLabel, itemLink, type Item } from '@cockpit/shared';
import type { Undoable } from './undo';

// The address itself is shared (`@cockpit/shared`, `domain/item-link.ts`): the MCP tools hand the same one to an app.
export { itemLink };

/**
 * Copying the link to an Item ("Copy an Item's link from its menu and its
 * form", issue 1247): the titled anchor, and the clipboard writes.
 */

/** Text written into HTML as it is written, `<`, `&` and quotes included. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** An anchor to the link with the title as its text, which Teams, Outlook, Notion and Google Docs paste as a titled link. */
export function itemLinkAsHtml(link: string, title: string): string {
  return `<a href="${escapeHtml(link)}">${escapeHtml(title)}</a>`;
}

type Linked = Pick<Item, 'id' | 'title' | 'nextAction'>;

/**
 * Puts the link on the clipboard as a plain URL and as one titled the way its
 * row names it (`itemLabel`), so an untitled Item still pastes as something to
 * click, and says whether the browser let it.
 *
 * **One write from the click's own gesture**, so nothing may be awaited before
 * it. Where `ClipboardItem` is missing the plain URL alone is written.
 */
export async function copyItemLink(workspaceId: string, item: Linked): Promise<boolean> {
  const link = itemLink(window.location.origin, workspaceId, item.id);
  const title = itemLabel(item);
  try {
    if (typeof ClipboardItem === 'undefined' || !navigator.clipboard.write) {
      await navigator.clipboard.writeText(link);
    } else {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([link], { type: 'text/plain' }),
          'text/html': new Blob([itemLinkAsHtml(link, title)], { type: 'text/html' }),
        }),
      ]);
    }
    return true;
  } catch {
    return false;
  }
}

/** Copies the link and says so on the bar, the one way the row's menu and the form both copy it. */
export async function copyItemLinkAndSay(
  workspaceId: string,
  item: Linked,
  offerToUndo: (change: Undoable) => void,
): Promise<void> {
  const copied = await copyItemLink(workspaceId, item);
  offerToUndo({ what: copied ? 'Link copied' : "Couldn't copy the link" });
}
