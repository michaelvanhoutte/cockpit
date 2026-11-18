import { useNavigate } from '@tanstack/react-router';
import { itemLabel } from '@cockpit/shared';
import { useSnapshot } from '../api/useSnapshot';
import { useOpenItem } from '../itemForm';
import { childrenOf, parentsOf } from './relations';
import {
  DEFAULT_KINDS,
  EMPTY_BOARD,
  FOCUS_KEY,
  boardKey,
  kindsKey,
  linksKey,
  readPoc,
  relationsKey,
  usePoc,
  viewKey,
  writePoc,
  type Board,
  type DashboardView,
  type LineKind,
  type Link,
  type Relations,
} from './store';

/** POC (throwaway): an Item's Parents, Children, links by kind, and where it is on a whiteboard - each one a way there. */
export function PocRelations({ workspaceId, itemId }: { workspaceId: string; itemId: string }) {
  const { data } = useSnapshot(workspaceId);
  const [relations] = usePoc<Relations>(relationsKey(workspaceId), {});
  const [links] = usePoc<Link[]>(linksKey(workspaceId), []);
  const [kinds] = usePoc<LineKind[]>(kindsKey(workspaceId), DEFAULT_KINDS);
  const openItem = useOpenItem();
  const navigate = useNavigate();
  if (!data) return null;
  const byId = new Map(data.items.map((item) => [item.id, item]));
  const name = (id: string) => {
    const [kind, rest] = id.includes(':') ? (id.split(/:(.*)/s) as [string, string]) : ['item', id];
    if (kind === 'panel') return data.panels.find((panel) => panel.id === rest)?.name ?? 'Panel';
    const item = byId.get(rest);
    return item ? itemLabel(item) : kind === 'node' ? 'a box' : 'an Item';
  };
  const go = (ref: string) => {
    const [kind, rest] = ref.split(/:(.*)/s) as [string, string];
    if (kind === 'item' && byId.has(rest)) openItem(rest);
  };

  const parents = parentsOf(relations, itemId);
  const children = childrenOf(relations, itemId);
  const me = `item:${itemId}`;
  const byKind = kinds.flatMap((kind) => {
    const out = links.filter((link) => link.kindId === kind.id && link.from === me).map((link) => link.to);
    const into = links.filter((link) => link.kindId === kind.id && link.to === me).map((link) => link.from);
    return out.length || into.length ? [{ kind, out, into }] : [];
  });
  const places = data.dashboards.flatMap((dashboard) => {
    const board = readPoc<Board>(boardKey(dashboard.id), EMPTY_BOARD);
    return board.nodes
      .filter((node) => node.kind === 'card' && node.itemId === itemId)
      .map((node) => {
        const holder = node.parentId ? board.nodes.find((one) => one.id === node.parentId) : undefined;
        const inside = !holder ? 'open board' : holder.kind === 'box' ? holder.name || 'a box' : holder.kind === 'card' ? name(holder.itemId) : holder.kind === 'panel' ? name(`panel:${holder.panelId}`) : 'a box';
        return { dashboard, nodeId: node.id, inside, onOpen: !holder };
      });
  });
  const showOnBoard = (dashboardId: string, nodeId: string) => {
    const view = readPoc<DashboardView>(viewKey(dashboardId), 'panels');
    if (view === 'panels') writePoc<DashboardView>(viewKey(dashboardId), 'side');
    writePoc(FOCUS_KEY, { dashboardId, nodeId });
    void navigate({ to: '/w/$workspaceId/d/$dashboardId', params: { workspaceId, dashboardId }, search: {} });
  };
  if (!parents.length && !children.length && !byKind.length && !places.length) return null;

  const link = 'text-accent-deep hover:underline';
  const row = (label: string, entries: React.ReactNode[]) =>
    entries.length > 0 && (
      <p className="text-sm text-ink-soft">
        <span className="font-medium text-ink">{label}: </span>
        {entries.map((entry, n) => (
          <span key={n}>
            {n > 0 && ', '}
            {entry}
          </span>
        ))}
      </p>
    );
  return (
    <section aria-label="Relations" className="flex flex-col gap-1" data-poc-relations>
      <h3 className="text-xs font-semibold tracking-[0.12em] text-ink-soft uppercase">Relations</h3>
      {row('Parents', parents.map((id) => <button key={id} type="button" className={link} onClick={() => openItem(id)}>{name(id)}</button>))}
      {row('Children', children.map((id) => <button key={id} type="button" className={link} onClick={() => openItem(id)}>{name(id)}</button>))}
      {byKind.map(({ kind, out, into }) => (
        <span key={kind.id}>
          {row(kind.name, out.map((ref) => <button key={ref} type="button" className={link} onClick={() => go(ref)}>{name(ref)}</button>))}
          {row(`${kind.name} (from)`, into.map((ref) => <button key={ref} type="button" className={link} onClick={() => go(ref)}>{name(ref)}</button>))}
        </span>
      ))}
      {row(
        'On whiteboards',
        places.map((place) => (
          <button key={place.nodeId} type="button" className={link} onClick={() => showOnBoard(place.dashboard.id, place.nodeId)}>
            {place.dashboard.name} · {place.onOpen ? 'on open board' : `in ${place.inside}`}
          </button>
        )),
      )}
    </section>
  );
}
