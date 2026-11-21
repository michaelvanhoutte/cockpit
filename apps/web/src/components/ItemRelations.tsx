import { childIdsOf, parentIdsOf, type Item } from '@cockpit/shared';
import { useSnapshot } from '../api/useSnapshot';

/**
 * What an Item's Relations tab lists ("Brainstorming: an Item can't hold other
 * Items", issue 1825): the Items holding it and the Items it holds, from the
 * Workspace's read. A child the read leaves out, finished long ago, is counted
 * by the Item's own counts rather than listed. The tab itself is
 * `ItemRelationsTab`, fetched when it opens; only its count is drawn with the form.
 */
export function useRelations(workspaceId: string, item: Item) {
  const { data } = useSnapshot(workspaceId);
  const rows = data?.children ?? [];
  const parents = parentIdsOf(rows, item.id);
  // Only the ones the read holds: one dismissed a moment ago is gone from it and from the counts.
  const held = new Set((data?.items ?? []).map((one) => one.id));
  const children = childIdsOf(rows, item.id).filter((id) => held.has(id));
  /** The children the read leaves out, which the counts kept on the Item still hold. */
  const notListed = Math.max(0, (item.childrenCount ?? 0) - children.length);
  /**
   * Its cards, one per Dashboard whose whiteboard holds it, with the box each
   * is in ("Brainstorming: give every Dashboard a whiteboard of its own", issue
   * 1829): *Novel · in People*.
   */
  const boards = data?.whiteboards;
  const places = (boards?.cards ?? [])
    .filter((card) => card.itemId === item.id)
    .flatMap((card) => {
      const dashboard = data?.dashboards.find((one) => one.id === card.dashboardId);
      if (!dashboard) return [];
      const box = card.boxId ? boards?.boxes.find((one) => one.id === card.boxId) : undefined;
      return [{ cardId: card.id, dashboardId: dashboard.id, dashboardName: dashboard.name, boxLabel: box ? box.label || 'Box' : null }];
    });
  /** Its links, either way, between it and an Item not dismissed ("Brainstorming: the whiteboard can't show how Items connect", issue 1831). */
  // Only to an Item the read holds, as for children: one finished long ago is named by nothing here.
  const links = (boards?.links ?? []).filter(
    (link) => (link.fromItemId === item.id && held.has(link.toItemId)) || (link.toItemId === item.id && held.has(link.fromItemId)),
  );
  return { data, parents, children, notListed, places, links };
}

/** *Relations · N*: every parent and every child, listed or not, every link, and every whiteboard it is on. */
export function useRelationCount(workspaceId: string, item: Item | null | undefined): number {
  const { parents, children, notListed, places, links } = useRelations(workspaceId, item ?? EMPTY);
  return item ? parents.length + children.length + notListed + links.length + places.length : 0;
}

const EMPTY = { id: '', childrenCount: 0 } as Item;
