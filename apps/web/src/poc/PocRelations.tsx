import { useNavigate } from '@tanstack/react-router';
import { itemLabel, panelGathers } from '@cockpit/shared';
import { useSnapshot } from '../api/useSnapshot';
import { useOpenItem } from '../itemForm';
import { boxCardId, openCardId } from './layout';
import { childrenOf, parentsOf } from './relations';
import {
  DEFAULT_KINDS,
  EMPTY_BOARD3,
  FOCUS_KEY,
  board3Key,
  kindsKey,
  linksKey,
  readPoc,
  relationsKey,
  usePoc,
  viewKey,
  writePoc,
  type Board3,
  type DashboardView,
  type LineKind,
  type Link,
  type Relations,
} from './store';

interface Place {
  dashboardId: string;
  dashboardName: string;
  nodeId: string;
  where: string;
}

/** Everything the Relations tab lists for one Item. */
function useRelations(workspaceId: string, itemId: string) {
  const { data } = useSnapshot(workspaceId);
  const [relations] = usePoc<Relations>(relationsKey(workspaceId), {});
  const [links] = usePoc<Link[]>(linksKey(workspaceId), []);
  const [kinds] = usePoc<LineKind[]>(kindsKey(workspaceId), DEFAULT_KINDS);
  const parents = parentsOf(relations, itemId);
  const children = childrenOf(relations, itemId);
  const me = `item:${itemId}`;
  const byKind = kinds.flatMap((kind) => {
    const out = links.filter((link) => link.kindId === kind.id && link.from === me).map((link) => link.to);
    const into = links.filter((link) => link.kindId === kind.id && link.to === me).map((link) => link.from);
    return out.length || into.length ? [{ kind, out, into }] : [];
  });
  // On a whiteboard: on its open space, and in the box of every Panel of that Dashboard it is filed on.
  const places: Place[] = (data?.dashboards ?? []).flatMap((dashboard) => {
    const board = readPoc<Board3>(board3Key(dashboard.id), EMPTY_BOARD3);
    const open = board.open
      .filter((card) => card.itemId === itemId)
      .map((card) => ({ dashboardId: dashboard.id, dashboardName: dashboard.name, nodeId: openCardId(card.id), where: 'on open board' }));
    const boxed = (data?.filings ?? [])
      .filter((filing) => filing.itemId === itemId)
      .flatMap((filing) => {
        const panel = data?.panels.find((one) => one.id === filing.panelId && one.dashboardId === dashboard.id && one.kind === 'items' && !panelGathers(one));
        return panel ? [{ dashboardId: dashboard.id, dashboardName: dashboard.name, nodeId: boxCardId(panel.id, itemId), where: `in ${panel.name}` }] : [];
      });
    return [...open, ...boxed];
  });
  return { data, parents, children, byKind, places };
}

export function usePocRelationCount(workspaceId: string, itemId: string): number {
  const { parents, children, byKind, places } = useRelations(workspaceId, itemId);
  return parents.length + children.length + byKind.reduce((n, one) => n + one.out.length + one.into.length, 0) + places.length;
}

/** POC (throwaway): an Item's Parents, Children, links by kind, and where it is on a whiteboard - each one a way there. */
export function PocRelations({ workspaceId, itemId }: { workspaceId: string; itemId: string }) {
  const { data, parents, children, byKind, places } = useRelations(workspaceId, itemId);
  const openItem = useOpenItem();
  const navigate = useNavigate();
  if (!data) return null;
  const byId = new Map(data.items.map((item) => [item.id, item]));
  const name = (ref: string) => {
    const [kind, rest] = ref.includes(':') ? (ref.split(/:(.*)/s) as [string, string]) : ['item', ref];
    if (kind === 'panel') return data.panels.find((panel) => panel.id === rest)?.name ?? 'Panel';
    const item = byId.get(rest);
    return item ? itemLabel(item) : kind === 'node' ? 'a sketch' : 'an Item';
  };
  const go = (ref: string) => {
    const [kind, rest] = ref.includes(':') ? (ref.split(/:(.*)/s) as [string, string]) : ['item', ref];
    if (kind === 'item' && byId.has(rest)) openItem(rest);
  };
  const showOnBoard = (place: Place) => {
    const view = readPoc<DashboardView>(viewKey(place.dashboardId), 'panels');
    if (view === 'panels') writePoc<DashboardView>(viewKey(place.dashboardId), 'side');
    writePoc(FOCUS_KEY, { dashboardId: place.dashboardId, nodeId: place.nodeId });
    void navigate({ to: '/w/$workspaceId/d/$dashboardId', params: { workspaceId, dashboardId: place.dashboardId }, search: {} });
  };
  if (!parents.length && !children.length && !byKind.length && !places.length)
    return <p className="text-sm text-ink-faint">No parents, children, links or whiteboards yet.</p>;

  const link = 'text-accent-deep hover:underline';
  const row = (label: string, entries: React.ReactNode[]) =>
    entries.length > 0 && (
      <div className="flex flex-col gap-1">
        <h3 className="text-xs font-semibold tracking-[0.12em] text-ink-soft uppercase">{label}</h3>
        <ul className="flex flex-col gap-0.5 text-sm">
          {entries.map((entry, n) => (
            <li key={n}>{entry}</li>
          ))}
        </ul>
      </div>
    );
  return (
    <section aria-label="Relations" className="flex flex-col gap-4" data-poc-relations>
      {row('Parents', parents.map((id) => <button key={id} type="button" className={link} onClick={() => openItem(id)}>{name(id)}</button>))}
      {row('Children', children.map((id) => <button key={id} type="button" className={link} onClick={() => openItem(id)}>{name(id)}</button>))}
      {byKind.map(({ kind, out, into }) => (
        <div key={kind.id} className="flex flex-col gap-4">
          {row(kind.name, out.map((ref) => <button key={ref} type="button" className={link} onClick={() => go(ref)}>{name(ref)}</button>))}
          {row(`${kind.name} (from)`, into.map((ref) => <button key={ref} type="button" className={link} onClick={() => go(ref)}>{name(ref)}</button>))}
        </div>
      ))}
      {row(
        'On whiteboards',
        places.map((place) => (
          <button key={place.nodeId} type="button" className={link} onClick={() => showOnBoard(place)}>
            {place.dashboardName} · {place.where}
          </button>
        )),
      )}
    </section>
  );
}
