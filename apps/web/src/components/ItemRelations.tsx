import { childIdsOf, itemLabel, parentIdsOf, type Item } from '@cockpit/shared';
import { useSnapshot } from '../api/useSnapshot';
import { useOpenItem } from '../itemForm';

/**
 * What an Item's Relations tab lists ("Brainstorming: an Item can't hold other
 * Items", issue 1825): the Items holding it and the Items it holds, from the
 * Workspace's read. A child the read leaves out, finished long ago, is counted
 * by the Item's own counts rather than listed.
 */
function useRelations(workspaceId: string, item: Item) {
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

/** The POC's Relations tab: Parents, then Children, each one opening that Item. */
export function ItemRelations({ workspaceId, item }: { workspaceId: string; item: Item }) {
  const { data, parents, children, notListed } = useRelations(workspaceId, item);
  const openItem = useOpenItem();
  if (!data) return null;
  if (parents.length === 0 && children.length === 0 && notListed === 0) {
    return <p className="text-sm text-ink-faint">No parents or children yet.</p>;
  }
  const byId = new Map(data.items.map((one) => [one.id, one]));
  const name = (id: string) => {
    const found = byId.get(id);
    return found ? itemLabel(found) : 'an Item';
  };
  const link = 'text-accent-deep hover:underline';
  const row = (label: string, ids: readonly string[], more = 0) =>
    (ids.length > 0 || more > 0) && (
      <div className="flex flex-col gap-1">
        <h3 className="text-xs font-semibold tracking-[0.12em] text-ink-soft uppercase">{label}</h3>
        <ul className="flex flex-col gap-0.5 text-sm">
          {ids.map((id) => (
            <li key={id}>
              <button type="button" className={link} onClick={() => openItem(id)}>
                {name(id)}
              </button>
            </li>
          ))}
          {more > 0 && (
            <li className="text-ink-faint">
              {more === 1 ? '1 more, finished earlier' : `${more} more, finished earlier`}
            </li>
          )}
        </ul>
      </div>
    );
  return (
    <section aria-label="Relations" className="flex flex-col gap-4">
      {row('Parents', parents)}
      {row('Children', children, notListed)}
    </section>
  );
}

const EMPTY = { id: '', childrenCount: 0 } as Item;
