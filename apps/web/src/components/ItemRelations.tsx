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
  return { data, parents, children, notListed };
}

/** *Relations · N*: every parent and every child, listed or not. */
export function useRelationCount(workspaceId: string, item: Item | null | undefined): number {
  const { parents, children, notListed } = useRelations(workspaceId, item ?? EMPTY);
  return item ? parents.length + children.length + notListed : 0;
}

const EMPTY = { id: '', childrenCount: 0 } as Item;
