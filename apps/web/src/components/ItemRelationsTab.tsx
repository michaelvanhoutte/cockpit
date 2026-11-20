import { itemLabel, uuidv7, type Item } from '@cockpit/shared';
import { useNavigate } from '@tanstack/react-router';
import { useSendCommand } from '../api/queries';
import { boardLayoutOf } from '../boardLayout';
import { showTheCard } from '../boardFocus';
import { useOpenItem } from '../itemForm';
import { useRoomForTheInbox } from '../roomForTheInbox';
import { useRelations } from './ItemRelations';

/**
 * The POC's Relations tab ("Brainstorming: an Item can't hold other Items",
 * issue 1825): Parents, then Children, each one opening that Item. Fetched
 * when the tab opens, so it costs the initial bundle nothing.
 */
export default function ItemRelationsTab({ workspaceId, item }: { workspaceId: string; item: Item }) {
  const { data, parents, children, notListed, places } = useRelations(workspaceId, item);
  const openItem = useOpenItem();
  const navigate = useNavigate();
  const send = useSendCommand();
  const atADesk = useRoomForTheInbox();
  if (!data) return null;
  if (parents.length === 0 && children.length === 0 && notListed === 0 && places.length === 0) {
    return <p className="text-sm text-ink-faint">No parents, children or whiteboards yet.</p>;
  }
  /** Goes to the card: its Dashboard, with the whiteboard beside its Panels where only they were shown, the card selected and in view. */
  const goToCard = (place: (typeof places)[number]) => {
    if (atADesk && boardLayoutOf(data, place.dashboardId).view === 'panels') {
      void send({
        name: 'set_dashboard_view',
        payload: { commandId: uuidv7(), issuedAt: new Date().toISOString(), workspaceId, dashboardId: place.dashboardId, view: 'side' },
      }).catch(() => {});
    }
    showTheCard(place.dashboardId, place.cardId);
    void navigate({ to: '/w/$workspaceId/d/$dashboardId', params: { workspaceId, dashboardId: place.dashboardId }, search: {} });
  };
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
      {places.length > 0 && (
        <div className="flex flex-col gap-1">
          <h3 className="text-xs font-semibold tracking-[0.12em] text-ink-soft uppercase">On whiteboards</h3>
          <ul className="flex flex-col gap-0.5 text-sm">
            {places.map((place) => (
              <li key={place.cardId}>
                <button type="button" className={link} onClick={() => goToCard(place)}>
                  {place.boxLabel ? `${place.dashboardName} · in ${place.boxLabel}` : place.dashboardName}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
