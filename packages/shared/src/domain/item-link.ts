/**
 * The link to an Item ("Copy an Item's link from its menu and its form", issue
 * 1247), the one address the browser copies and the MCP tools (`create_item`'s
 * reply, `find_items`' results) hand to an app.
 *
 * **The Item's own workspace, not the view it was copied from**: `/w/<workspace>`
 * opens the last view visited with `?item=` open over it (`itemForm.ts`), so
 * the link survives the Dashboard it was copied from being deleted.
 */
export function itemLink(origin: string, workspaceId: string, itemId: string): string {
  return `${origin}/w/${encodeURIComponent(workspaceId)}?item=${encodeURIComponent(itemId)}`;
}
