/**
 * Copying the link to an Item ("Copy an Item's link from its menu and its
 * form", issue 1247).
 *
 * **The Item's own workspace, not the view it was copied from**: `/w/<workspace>`
 * opens the last view visited with `?item=` open over it (`itemForm.ts`), so
 * the link survives the Dashboard it was copied from being deleted.
 */
export function itemLink(origin: string, workspaceId: string, itemId: string): string {
  return `${origin}/w/${encodeURIComponent(workspaceId)}?item=${encodeURIComponent(itemId)}`;
}

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

/**
 * Puts the link on the clipboard as a plain URL and as a titled one, and says
 * whether the browser let it.
 *
 * **One write from the click's own gesture**, so nothing may be awaited before
 * it. Where `ClipboardItem` is missing the plain URL alone is written.
 */
export async function copyItemLink(workspaceId: string, itemId: string, title: string): Promise<boolean> {
  const link = itemLink(window.location.origin, workspaceId, itemId);
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
