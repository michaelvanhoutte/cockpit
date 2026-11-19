import { insideOf, type Item } from '@cockpit/shared';
import { useSnapshot } from '../api/useSnapshot';
import { useRelationCount } from './ItemRelations';

/**
 * What the Item form says of the Items holding this one and held by it
 * ("Brainstorming: an Item can't hold other Items", issue 1825), fetched with
 * the form's first draw rather than carried in the initial bundle.
 */

/** *· N* after the Relations tab's name: every parent and every child, listed or not. None says nothing. */
export function RelationCount({ workspaceId, item }: { workspaceId: string; item: Item }) {
  const count = useRelationCount(workspaceId, item);
  if (count === 0) return null;
  return (
    <>
      {' '}
      <span className="text-ink-faint">· {count}</span>
    </>
  );
}

/** Where an Item on no Panel is, in the read view: inside the Items holding it, or else the Inbox. */
export function InsideOrInbox({ workspaceId, itemId }: { workspaceId: string; itemId: string }) {
  const { data } = useSnapshot(workspaceId);
  const inside = insideOf(itemId, data?.children ?? [], data?.items ?? []);
  return <>{inside.length > 0 ? `Inside ${inside.join(', ')}` : 'In the Inbox'}</>;
}
