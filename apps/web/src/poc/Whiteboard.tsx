import '@xyflow/react/dist/style.css';
import * as Popover from '@radix-ui/react-popover';
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  ConnectionMode,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  ViewportPortal,
  applyNodeChanges,
  getStraightPath,
  useInternalNode,
  useNodesInitialized,
  useReactFlow,
  useViewport,
  type Edge,
  type EdgeChange,
  type EdgeProps,
  type FinalConnectionState,
  type InternalNode,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react';
import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { itemLabel, itemStatus, panelGathers, stillOpen, type Item } from '@cockpit/shared';
import { useSendCommand, type CommandArgs } from '../api/queries';
import { useSnapshot } from '../api/useSnapshot';
import { ITEM_BEING_DRAGGED } from '../dropAt';
import { useOpenItem } from '../itemForm';
import { selectionCarried } from '../itemInTheAir';
import { sourceOnARow } from '../itemSource';
import { useUndo } from '../undo';
import { ink, tint, useColours, Swatches, type Colour } from './colour';
import { askToCombine } from './dialogs';
import { BOX_HEAD, CARD_H, CARD_W, absoluteOf, boxId, layout, openCardId, sizeOfPlaced, sketchId, type Placed } from './layout';
import { addChildren, dropParent, isUuid } from './relations';
import { PocRowExtras } from './rowExtras';
import { StatusMark } from './StatusMark';
import {
  DEFAULT_KINDS,
  EMPTY_BOARD3,
  FOCUS_KEY,
  LEADS_TO,
  board3Key,
  hiddenKey,
  kindsKey,
  linksKey,
  newId,
  panelItemsKey,
  panelParentsKey,
  usePoc,
  writePoc,
  type Board3,
  type LineKind,
  type LineStyle,
  type Link,
} from './store';

/** POC (throwaway): a Dashboard's whiteboard. Its boxes are the Dashboard's Panels; what a box holds is what its Panel holds. */

const ItemList = lazy(() => import('../components/ItemList').then((loaded) => ({ default: loaded.ItemList })));

type Status = ReturnType<typeof itemStatus>;
type CardData = { title: string; status: Status; source: string | null; missing: boolean; sketch: boolean; colour: Colour | undefined; count: number };
type BoxData = { name: string; count: number; collapsed: boolean; colour: Colour | undefined };
type CardNode = Node<CardData, 'card'>;
type BoxNode = Node<BoxData, 'box'>;
type FlowNode = CardNode | BoxNode;
type KindEdgeData = { kind: LineKind; label: string | undefined; linkId: string; hovered: boolean };
type KindEdge = Edge<KindEdgeData, 'kind'>;

const STATUS_WORDS: Record<Status, string> = { to_do: 'To do', in_progress: 'In progress', waiting: 'Waiting', done: 'Done' };
const SWATCHES = ['#3a3f4b', '#6f62b5', '#0e7490', '#0b7a55', '#9a5b14', '#bf5d55'];
const GRID = 20;
const PHONE_ZOOM = 0.7;
const DOUBLE_MS = 350;
const NARROW = 700;

interface Ctx {
  readOnly: boolean;
  editingId: string | null;
  showLabels: boolean;
  dropTargetId: string | null;
  flashId: string | null;
  commitName: (id: string, text: string) => void;
  stopEditing: () => void;
  zoomTo: (id: string) => void;
  toggleCollapsed: (id: string) => void;
  titleClicked: (id: string, wasSelected: boolean, event: React.MouseEvent) => void;
}
const BoardContext = createContext<Ctx>({
  readOnly: true,
  editingId: null,
  showLabels: false,
  dropTargetId: null,
  flashId: null,
  commitName: () => {},
  stopEditing: () => {},
  zoomTo: () => {},
  toggleCollapsed: () => {},
  titleClicked: () => {},
});

/**
 * A name typed in place. Until it has the focus every key meant for it is
 * caught first and put into it, so no app shortcut fires and no first letter
 * is lost. Enter saves, Escape cancels.
 */
function InlineName({ id, initial, placeholder, className }: { id: string; initial: string; placeholder: string; className: string }) {
  const { commitName, stopEditing } = useContext(BoardContext);
  const [text, setText] = useState(initial);
  const field = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    if (save) commitName(id, text);
    else stopEditing();
  };
  useEffect(() => {
    const catchKey = (event: KeyboardEvent) => {
      const input = field.current;
      if (!input || document.activeElement === input) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
        setText((was) => was + event.key);
        input.focus();
      } else if (event.key === 'Enter') finish(true);
      else if (event.key === 'Escape') finish(false);
      else input.focus();
    };
    window.addEventListener('keydown', catchKey, true);
    const later = window.setTimeout(() => {
      field.current?.focus();
      field.current?.select();
    }, 30);
    return () => {
      window.removeEventListener('keydown', catchKey, true);
      window.clearTimeout(later);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <input
      ref={field}
      value={text}
      placeholder={placeholder}
      aria-label={placeholder}
      onChange={(event) => setText(event.target.value)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter') finish(true);
        if (event.key === 'Escape') finish(false);
      }}
      onBlur={() => finish(true)}
      onPointerDown={(event) => event.stopPropagation()}
      className={`nodrag nopan min-w-0 flex-1 rounded border border-accent bg-field px-1 outline-none ${className}`}
    />
  );
}

/** A connection dot on each side, shown on hover; drag one to another card or box to link them. */
function Dots() {
  const { readOnly } = useContext(BoardContext);
  if (readOnly) return null;
  return (
    <>
      {([Position.Top, Position.Right, Position.Bottom, Position.Left] as const).map((side) => (
        <Handle key={side} id={side} type="source" position={side} className="poc-dot" />
      ))}
    </>
  );
}

function marks(id: string, ctx: Ctx, selected: boolean | undefined) {
  if (ctx.flashId === id) return 'ring-4 ring-accent animate-pulse';
  if (ctx.dropTargetId === id) return 'ring-4 ring-accent/60';
  return selected ? 'ring-2 ring-accent' : '';
}

function CardView({ id, data, selected, parentId }: NodeProps<CardNode>) {
  const ctx = useContext(BoardContext);
  const finished = data.status === 'done';
  const colour = data.colour;
  return (
    <div
      data-card={data.title}
      data-inside={parentId ? 'box' : 'open'}
      className={`group flex h-[64px] w-[200px] flex-col justify-center gap-1 rounded-md border px-2.5 py-1.5 text-left shadow-panel ${
        data.sketch ? 'border-dashed border-accent/60 bg-accent-tint/60' : 'border-shade/10 bg-field'
      } ${marks(id, ctx, selected)} ${finished || data.missing ? 'opacity-60' : ''}`}
      style={colour ? { background: tint(colour), boxShadow: `inset 4px 0 0 0 ${ink(colour)}` } : undefined}
    >
      <Dots />
      {ctx.editingId === id ? (
        <InlineName id={id} initial={data.title} placeholder={data.sketch ? 'Name this sketch' : 'Title'} className="text-sm" />
      ) : (
        <span
          onClick={(event) => ctx.titleClicked(id, Boolean(selected), event)}
          className={`line-clamp-2 text-[13px] leading-tight font-medium ${finished ? 'text-ink-faint line-through' : 'text-ink-strong'}`}
        >
          {data.title || <span className="text-ink-faint italic">Untitled sketch</span>}
        </span>
      )}
      <span className="flex items-center gap-1.5 text-[11px] text-ink-faint">
        {data.sketch ? (
          <span className="italic">Sketch · not saved</span>
        ) : data.missing ? (
          <span>Not in this Workspace now</span>
        ) : (
          <>
            <StatusMark status={data.status} />
            <span>{STATUS_WORDS[data.status]}</span>
            {data.count > 0 && (
              <span className="truncate text-accent-deep">
                · {data.count} {data.count === 1 ? 'Item' : 'Items'}
              </span>
            )}
            {data.source && <span className="truncate">· {data.source}</span>}
          </>
        )}
      </span>
    </div>
  );
}

function BoxView({ id, data, selected }: NodeProps<BoxNode>) {
  const ctx = useContext(BoardContext);
  const colour = data.colour;
  return (
    <div
      data-box={data.name}
      data-collapsed={data.collapsed ? 'yes' : 'no'}
      className={`h-full w-full rounded-lg border-2 ${selected ? 'border-accent' : 'border-accent/35'} ${data.collapsed ? 'shadow-panel' : ''} ${marks(id, ctx, false)}`}
      style={{
        background: colour ? `color-mix(in srgb, ${tint(colour)} 70%, transparent)` : 'color-mix(in srgb, var(--color-accent-tint) 30%, transparent)',
        ...(colour ? { borderColor: ink(colour) } : {}),
      }}
    >
      <Dots />
      <div className="group/head flex h-[40px] items-center gap-1.5 px-2">
        <button
          type="button"
          aria-label={data.collapsed ? `Expand ${data.name}` : `Collapse ${data.name}`}
          aria-expanded={!data.collapsed}
          onClick={(event) => {
            event.stopPropagation();
            ctx.toggleCollapsed(id);
          }}
          className="nodrag nopan flex size-5 shrink-0 items-center justify-center rounded text-xs text-ink-soft hover:bg-accent-tint"
        >
          {data.collapsed ? '▸' : '▾'}
        </button>
        {ctx.editingId === id ? (
          <InlineName id={id} initial={data.name} placeholder="Name this Panel" className="text-sm font-semibold" />
        ) : (
          <span
            onClick={(event) => ctx.titleClicked(id, Boolean(selected), event)}
            className="min-w-0 flex-1 truncate text-xs font-semibold tracking-[0.12em] uppercase"
            style={{ color: colour ? ink(colour) : 'var(--color-accent-deep)' }}
          >
            {data.name || 'Panel'}
          </span>
        )}
        <span className="shrink-0 text-xs text-ink-faint">
          {data.count} {data.count === 1 ? 'Item' : 'Items'}
        </span>
        {!data.collapsed && (
          <button
            type="button"
            title="Zoom to box"
            aria-label={`Zoom to ${data.name || 'box'}`}
            onClick={(event) => {
              event.stopPropagation();
              ctx.zoomTo(id);
            }}
            className="nodrag nopan flex size-5 shrink-0 items-center justify-center rounded text-ink-soft opacity-0 group-hover/head:opacity-100 hover:bg-accent-tint hover:text-accent-deep"
          >
            <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
              <circle cx="7" cy="7" r="4.5" />
              <path d="M10.5 10.5 14 14M5 7h4M7 5v4" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}

/** Where the line between two nodes' centres leaves the first one's rectangle. */
function borderPoint(node: InternalNode, toward: { x: number; y: number }) {
  const w = node.measured.width ?? 0;
  const h = node.measured.height ?? 0;
  const cx = node.internals.positionAbsolute.x + w / 2;
  const cy = node.internals.positionAbsolute.y + h / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const scale = Math.min(dx === 0 ? Infinity : w / 2 / Math.abs(dx), dy === 0 ? Infinity : h / 2 / Math.abs(dy));
  return { x: cx + dx * scale, y: cy + dy * scale };
}
const centre = (node: InternalNode) => ({
  x: node.internals.positionAbsolute.x + (node.measured.width ?? 0) / 2,
  y: node.internals.positionAbsolute.y + (node.measured.height ?? 0) / 2,
});

const DASHES: Record<LineStyle, string | undefined> = { solid: undefined, dashed: '9 6', dotted: '1.5 5', double: undefined };

function KindEdgeView({ id, source, target, data, markerEnd, selected }: EdgeProps<KindEdge>) {
  const { showLabels } = useContext(BoardContext);
  const from = useInternalNode(source);
  const to = useInternalNode(target);
  if (!from || !to || !data) return null;
  const start = borderPoint(from, centre(to));
  const end = borderPoint(to, centre(from));
  const [path, labelX, labelY] = getStraightPath({ sourceX: start.x, sourceY: start.y, targetX: end.x, targetY: end.y });
  const { kind } = data;
  const width = selected ? 2.75 : 1.75;
  const label = data.label ?? (showLabels || data.hovered || selected ? kind.name : null);
  return (
    <>
      {kind.style === 'double' ? (
        <>
          <BaseEdge id={id} path={path} {...(markerEnd ? { markerEnd } : {})} style={{ stroke: kind.colour, strokeWidth: width + 4 }} interactionWidth={18} />
          <path d={path} fill="none" stroke="var(--color-surface)" strokeWidth={width} pointerEvents="none" />
        </>
      ) : (
        <BaseEdge
          id={id}
          path={path}
          {...(markerEnd ? { markerEnd } : {})}
          interactionWidth={18}
          style={{
            stroke: kind.colour,
            strokeWidth: width,
            strokeLinecap: kind.style === 'dotted' ? 'round' : 'butt',
            ...(DASHES[kind.style] ? { strokeDasharray: DASHES[kind.style] } : {}),
          }}
        />
      )}
      {label !== null && (
        <EdgeLabelRenderer>
          {/* Plain text on the board's own ground: no chip, no shadow. */}
          <div
            className="nodrag nopan pointer-events-none absolute px-1 text-[11px] font-medium"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, color: kind.colour, background: 'var(--color-surface)' }}
            data-edge-label={label}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const nodeTypes = { card: CardView, box: BoxView };
const edgeTypes = { kind: KindEdgeView };

/** The endpoint a link names: the Item of a card, the Panel of a box, or a sketch itself. */
const refOf = (one: Placed) => (one.kind === 'card' ? `item:${one.itemId}` : one.kind === 'box' ? `panel:${one.panelId}` : `node:${one.sketch}`);

type Tool = 'select' | 'box' | 'line';
type Drawing = { tool: Tool | 'arrow'; x0: number; y0: number; x1: number; y1: number };
type Menu = { x: number; y: number; nodeId: string | null };
/** What was let go over a card, waiting for Put inside / Combine with. */
type DropAsk = { x: number; y: number; targetId: string; itemId: string; fromId: string | null };
/** A box drawn with the Box tool and not yet named: it becomes a Panel once it is. */
type Pending = { id: string; x: number; y: number; w: number; h: number; parentPanel: string | null };

function BoardInner({ workspaceId, dashboardId, readOnly }: { workspaceId: string; dashboardId: string; readOnly: boolean }) {
  const { data } = useSnapshot(workspaceId);
  const openItem = useOpenItem();
  const send = useSendCommand();
  const offerToUndo = useUndo();
  const flow = useReactFlow<FlowNode, KindEdge>();
  const initialised = useNodesInitialized();
  const { zoom } = useViewport();
  const [board, setBoard] = usePoc<Board3>(board3Key(dashboardId), EMPTY_BOARD3);
  const [hidden] = usePoc<string[]>(hiddenKey(workspaceId), []);
  const [parentOf, setParentOf] = usePoc<Record<string, string>>(panelParentsKey(workspaceId), {});
  const [panelItem, setPanelItem] = usePoc<Record<string, string>>(panelItemsKey(workspaceId), {});
  const [colours, setColours] = useColours(workspaceId);
  const [kinds, setKinds] = usePoc<LineKind[]>(kindsKey(workspaceId), DEFAULT_KINDS);
  const [links, setLinks] = usePoc<Link[]>(linksKey(workspaceId), []);
  const [tool, setTool] = useState<Tool>('select');
  const [kindId, setKindId] = useState(LEADS_TO);
  const [showLabels, setShowLabels] = useState(false);
  const [grid, setGrid] = useState(true);
  const [full, setFull] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingLine, setEditingLine] = useState<string | null>(null);
  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null);
  const [edgePop, setEdgePop] = useState<{ x: number; y: number; linkId: string } | null>(null);
  const [drawing, setDrawing] = useState<Drawing | null>(null);
  const [arrowFrom, setArrowFrom] = useState<string | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [rowMenu, setRowMenu] = useState<{ x: number; y: number; nodeId: string; itemId: string; panelId: string | null; n: number } | null>(null);
  const [colourFor, setColourFor] = useState<{ x: number; y: number; key: string } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [dropAsk, setDropAsk] = useState<DropAsk | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [nodes, setNodes] = useState<FlowNode[]>([]);
  const [selectedEdges, setSelectedEdges] = useState<Set<string>>(new Set());
  const [width, setWidth] = useState(1000);
  const wrapper = useRef<HTMLDivElement>(null);
  const cameraPlaced = useRef(false);
  const lastClick = useRef<{ id: string; at: number } | null>(null);
  const renameLater = useRef<number | null>(null);
  const narrow = width < NARROW;

  // POC only: lets a driving script move the camera.
  if (import.meta.env.DEV) (window as unknown as { __pocFlow?: unknown }).__pocFlow = flow;

  useEffect(() => {
    const el = wrapper.current;
    if (!el || typeof ResizeObserver !== 'function') return;
    const watch = new ResizeObserver((entries) => setWidth(entries[0]?.contentRect.width ?? 1000));
    watch.observe(el);
    return () => watch.disconnect();
  }, []);

  const items = useMemo(() => new Map((data?.items ?? []).map((item) => [item.id, item])), [data]);
  const kind = kinds.find((one) => one.id === kindId) ?? kinds[0]!;
  const panels = useMemo(
    () => (data?.panels ?? []).filter((panel) => panel.dashboardId === dashboardId && panel.kind === 'items' && !panelGathers(panel)),
    [data, dashboardId],
  );
  const panelName = useCallback((panelId: string) => data?.panels.find((panel) => panel.id === panelId)?.name ?? 'Panel', [data]);
  const filed = useCallback(
    (panelId: string) =>
      (data?.filings ?? [])
        .filter((filing) => filing.panelId === panelId)
        .sort((a, b) => a.position - b.position)
        .map((filing) => filing.itemId)
        .filter((id) => {
          const item = items.get(id);
          return item && stillOpen(item) && !hidden.includes(id);
        }),
    [data, items, hidden],
  );
  const { placed, missing } = useMemo(
    () => layout({ board, panels, filed, parentOf, panelItem }),
    [board, panels, filed, parentOf, panelItem],
  );
  const byId = useMemo(() => new Map(placed.map((one) => [one.id, one])), [placed]);

  // New Panels get a place on the board, and keep it.
  useEffect(() => {
    if (readOnly || !data || Object.keys(missing).length === 0) return;
    setBoard((was) => ({ ...was, boxes: { ...missing, ...was.boxes } }));
  }, [missing, readOnly, data, setBoard]);

  const childCount = useCallback((itemId: string) => {
    const made = Object.entries(panelItem).find(([, item]) => item === itemId)?.[0];
    return made ? filed(made).length : 0;
  }, [panelItem, filed]);

  useEffect(() => {
    setNodes((was) => {
      const selected = new Set(was.filter((node) => node.selected).map((node) => node.id));
      return placed.map((one): FlowNode => {
        const common = { id: one.id, position: { x: one.x, y: one.y }, selected: selected.has(one.id), ...('parent' in one && one.parent ? { parentId: one.parent } : {}) };
        if (one.kind === 'box') {
          return {
            ...common,
            type: 'box',
            width: one.w,
            height: one.h,
            zIndex: -1,
            data: { name: panelName(one.panelId), count: one.count, collapsed: one.collapsed, colour: colours[`panel:${one.panelId}`] },
          };
        }
        if (one.kind === 'sketch') {
          return { ...common, type: 'card', data: { title: one.title, status: 'to_do', source: null, missing: false, sketch: true, colour: undefined, count: 0 } };
        }
        const item = items.get(one.itemId);
        return {
          ...common,
          type: 'card',
          data: {
            title: item ? itemLabel(item) : 'Item',
            status: item ? itemStatus(item) : 'to_do',
            source: item && item.source !== 'internal' ? sourceOnARow(item, data?.sourceNames) : null,
            missing: !item,
            sketch: false,
            colour: colours[`item:${one.itemId}`],
            count: childCount(one.itemId),
          },
        };
      });
    });
  }, [placed, items, colours, panelName, data?.sourceNames, childCount]);

  // ---- Commands, through the app's own client ----
  const envelope = () => ({ commandId: crypto.randomUUID(), issuedAt: new Date().toISOString(), workspaceId });
  const run = (name: CommandArgs['name'], payload: Record<string, unknown>) =>
    void send({ name, payload: { ...envelope(), ...payload } } as CommandArgs).catch((failure: unknown) =>
      offerToUndo({ what: `That did not save: ${String(failure)}` }),
    );
  const fileOn = (itemId: string, panelId: string, fromPanel: string | null) => {
    if (!isUuid(itemId) || !isUuid(panelId)) return;
    const order = [...filed(panelId).filter((id) => id !== itemId), itemId];
    if (fromPanel && isUuid(fromPanel)) run('move_item_to_panel', { itemId, panelId, order, fromPanelIds: [fromPanel] });
    else run('add_item_to_panel', { itemId, panelId, order });
  };
  const takeOffPanel = (itemId: string, panelId: string) => isUuid(panelId) && run('remove_item_from_panel', { itemId, panelId });
  const isFiled = (itemId: string, panelId: string) => (data?.filings ?? []).some((filing) => filing.itemId === itemId && filing.panelId === panelId);

  // ---- The camera ----
  useEffect(() => {
    if (!initialised || cameraPlaced.current || placed.length === 0) return;
    cameraPlaced.current = true;
    if (readOnly) {
      const tops = placed.filter((one) => !('parent' in one && one.parent));
      const minX = Math.min(...tops.map((one) => one.x));
      const minY = Math.min(...tops.map((one) => one.y));
      void flow.setViewport({ x: 16 - minX * PHONE_ZOOM, y: 16 - minY * PHONE_ZOOM, zoom: PHONE_ZOOM });
    } else void flow.fitView({ padding: 0.05, maxZoom: 1 });
  }, [initialised, placed, readOnly, flow]);
  const fitAll = useCallback(() => void flow.fitView({ duration: 400, padding: 0.05 }), [flow]);

  const [focus] = usePoc<{ dashboardId: string; nodeId: string } | null>(FOCUS_KEY, null);
  useEffect(() => {
    if (!initialised || !focus || focus.dashboardId !== dashboardId) return;
    writePoc(FOCUS_KEY, null);
    setNodes((was) => was.map((node) => ({ ...node, selected: node.id === focus.nodeId })));
    window.setTimeout(() => void flow.fitView({ nodes: [{ id: focus.nodeId }], duration: 600, maxZoom: 1.2, padding: 0.4 }), 50);
    setFlashId(focus.nodeId);
    window.setTimeout(() => setFlashId(null), 1400);
  }, [initialised, focus, dashboardId, flow]);

  // ---- Edges, from the Workspace's links, between every pair of nodes drawn for their ends ----
  const edges = useMemo(() => {
    const byRef = new Map<string, string[]>();
    for (const one of placed) byRef.set(refOf(one), [...(byRef.get(refOf(one)) ?? []), one.id]);
    return links.flatMap((link) => {
      const linkKind = kinds.find((one) => one.id === link.kindId) ?? kinds[0]!;
      return (byRef.get(link.from) ?? []).flatMap((source) =>
        (byRef.get(link.to) ?? [])
          .filter((target) => target !== source)
          .map((target): KindEdge => {
            const id = `${link.id}|${source}|${target}`;
            return {
              id,
              source,
              target,
              type: 'kind',
              selected: selectedEdges.has(id),
              ...(linkKind.arrow ? { markerEnd: { type: MarkerType.ArrowClosed, color: linkKind.colour, width: 16, height: 16 } } : {}),
              data: { kind: linkKind, label: link.label, linkId: link.id, hovered: hoveredEdge === id },
            };
          }),
      );
    });
  }, [placed, links, kinds, hoveredEdge, selectedEdges]);

  // ---- Small helpers ----
  const flash = useCallback(
    (nodeId: string) => {
      setFlashId(nodeId);
      window.setTimeout(() => setFlashId(null), 1400);
      const one = byId.get(nodeId);
      if (!one) return;
      const spot = absoluteOf(placed, nodeId);
      const size = sizeOfPlaced(one);
      void flow.setCenter(spot.x + size.w / 2, spot.y + size.h / 2, { zoom: Math.max(zoom, 0.6), duration: 450 });
    },
    [byId, placed, flow, zoom],
  );
  const zoomTo = useCallback((id: string) => void flow.fitView({ nodes: [{ id }], duration: 500, padding: 0.12 }), [flow]);
  const toggleCollapsed = useCallback(
    (id: string) => {
      const one = byId.get(id);
      if (one?.kind !== 'box') return;
      setBoard((was) => {
        const place = was.boxes[one.panelId] ?? { x: one.x, y: one.y };
        return { ...was, boxes: { ...was.boxes, [one.panelId]: { ...place, collapsed: !place.collapsed } } };
      });
    },
    [byId, setBoard],
  );
  /** A Panel box with no Item behind it: show its Panel in the Panels pane. */
  const showPanel = (panelId: string) => {
    const section = document.querySelector<HTMLElement>(`[data-poc-panel="${panelId}"]`);
    if (!section) return;
    section.scrollIntoView({ behavior: 'smooth', block: 'center' });
    section.animate([{ outline: '3px solid var(--color-accent)' }, { outline: '3px solid transparent' }], { duration: 1400 });
  };
  const open = (id: string) => {
    const one = byId.get(id);
    if (!one) return;
    if (one.kind === 'card') openItem(one.itemId);
    else if (one.kind === 'box') {
      const item = panelItem[one.panelId];
      if (item) openItem(item);
      else showPanel(one.panelId);
    } else if (!readOnly) setEditingId(id);
  };
  const startRename = (id: string) => {
    if (readOnly) return;
    if (renameLater.current) window.clearTimeout(renameLater.current);
    renameLater.current = null;
    setEditingId(id);
  };

  /** Second click on the title of what is already selected renames it - unless it turns out to be a double-click. */
  const titleClicked = useCallback(
    (id: string, wasSelected: boolean, event: React.MouseEvent) => {
      if (readOnly || !wasSelected || event.shiftKey || event.metaKey || event.ctrlKey || event.detail > 1) {
        if (renameLater.current) window.clearTimeout(renameLater.current);
        renameLater.current = null;
        return;
      }
      if (renameLater.current) window.clearTimeout(renameLater.current);
      renameLater.current = window.setTimeout(() => {
        renameLater.current = null;
        setEditingId(id);
      }, DOUBLE_MS + 20);
    },
    [readOnly],
  );

  const commitName = useCallback(
    (id: string, text: string) => {
      setEditingId(null);
      const name = text.trim();
      if (id === pending?.id) {
        setPending(null);
        if (!name) return;
        const panelId = crypto.randomUUID();
        run('add_panel', { dashboardId, panelId, name: name.slice(0, 60), kind: 'items' });
        setBoard((was) => ({ ...was, boxes: { ...was.boxes, [panelId]: { x: pending.x, y: pending.y, w: pending.w, h: pending.h } } }));
        if (pending.parentPanel) setParentOf((was) => ({ ...was, [panelId]: pending.parentPanel! }));
        return;
      }
      const one = byId.get(id);
      if (!one || !name) return;
      if (one.kind === 'sketch') setBoard((was) => ({ ...was, sketches: was.sketches.map((s) => (s.id === one.sketch ? { ...s, title: name } : s)) }));
      else if (one.kind === 'box' && name !== panelName(one.panelId)) run('rename_panel', { panelId: one.panelId, name: name.slice(0, 60) });
      else if (one.kind === 'card' && name !== itemLabel(items.get(one.itemId) ?? { title: '' })) run('set_title', { itemId: one.itemId, title: name });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pending, byId, items, panelName, dashboardId],
  );
  const ctx = useMemo<Ctx>(
    () => ({
      readOnly,
      editingId,
      showLabels,
      dropTargetId,
      flashId,
      commitName,
      stopEditing: () => {
        setEditingId(null);
        setPending(null);
      },
      zoomTo,
      toggleCollapsed,
      titleClicked,
    }),
    [readOnly, editingId, showLabels, dropTargetId, flashId, commitName, zoomTo, toggleCollapsed, titleClicked],
  );

  /** Takes an open card or a sketch off the board. A card in a box is never taken off: it leaves its Panel instead. */
  const takeOff = (id: string) => {
    const one = byId.get(id);
    if (!one) return;
    if (one.kind === 'card' && !one.panelId) setBoard((was) => ({ ...was, open: was.open.filter((card) => openCardId(card.id) !== id) }));
    if (one.kind === 'sketch') setBoard((was) => ({ ...was, sketches: was.sketches.filter((s) => s.id !== one.sketch) }));
  };
  const deletePanel = (panelId: string) => {
    setDeleting(null);
    run('delete_panel', { panelId });
    setBoard((was) => {
      const boxes = { ...was.boxes };
      delete boxes[panelId];
      const inBox = { ...was.inBox };
      delete inBox[panelId];
      return { ...was, boxes, inBox };
    });
    setParentOf((was) => Object.fromEntries(Object.entries(was).filter(([child, parent]) => child !== panelId && parent !== panelId)));
  };

  const onNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => {
    setNodes((was) => applyNodeChanges(changes.filter((change) => change.type !== 'remove'), was));
  }, []);
  const onEdgesChange = useCallback(
    (changes: EdgeChange<KindEdge>[]) => {
      setSelectedEdges((was) => {
        const next = new Set(was);
        for (const change of changes) if (change.type === 'select') (change.selected ? next.add(change.id) : next.delete(change.id));
        return next;
      });
      const removed = changes.flatMap((change) => (change.type === 'remove' ? [change.id.split('|')[0]!] : []));
      if (removed.length) setLinks((was) => was.filter((link) => !removed.includes(link.id)));
    },
    [setLinks],
  );

  // ---- What is under the pointer ----
  const nodeUnder = (clientX: number, clientY: number, skip: Set<string> = new Set()): string | null => {
    for (const element of document.elementsFromPoint(clientX, clientY)) {
      const node = element.closest('.react-flow__node');
      if (node instanceof HTMLElement && node.dataset.id && !skip.has(node.dataset.id)) return node.dataset.id;
    }
    return null;
  };
  const inside = (id: string): Set<string> => {
    const out = new Set([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const one of placed) if ('parent' in one && one.parent && out.has(one.parent) && !out.has(one.id)) (out.add(one.id), (grew = true));
    }
    return out;
  };
  const skipping = (ids: string[]) => {
    const skip = new Set<string>();
    ids.forEach((id) => inside(id).forEach((one) => skip.add(one)));
    return skip;
  };

  const onNodeDrag = (event: React.MouseEvent | MouseEvent | TouchEvent, _: FlowNode, dragged: FlowNode[]) => {
    if (!('clientX' in event)) return;
    const under = nodeUnder(event.clientX, event.clientY, skipping(dragged.map((one) => one.id)));
    if (under !== dropTargetId) setDropTargetId(under);
  };

  /** Where a dragged thing is now, on the board itself. */
  const absoluteNow = (node: FlowNode) => {
    const parent = node.parentId ? absoluteOf(placed, node.parentId) : { x: 0, y: 0 };
    return { x: parent.x + node.position.x, y: parent.y + node.position.y };
  };
  const boxOf = (id: string | null | undefined) => {
    const one = id ? byId.get(id) : undefined;
    return one?.kind === 'box' ? one : undefined;
  };
  const relativeTo = (panelId: string, at: { x: number; y: number }) => {
    const base = absoluteOf(placed, boxId(panelId));
    return { x: Math.max(8, at.x - base.x), y: Math.max(BOX_HEAD, at.y - base.y) };
  };

  /** A drag on the board ended. Into a box files the Item there; out onto open space takes it off; onto a card asks. */
  const onNodeDragStop = (event: React.MouseEvent | MouseEvent | TouchEvent, _: FlowNode, dragged: FlowNode[]) => {
    setDropTargetId(null);
    const point = 'clientX' in event ? { x: event.clientX, y: event.clientY } : null;
    const targetId = point ? nodeUnder(point.x, point.y, skipping(dragged.map((one) => one.id))) : null;
    const target = targetId ? byId.get(targetId) : undefined;

    if (dragged.length !== 1) {
      setBoard((was) => {
        let next = was;
        for (const node of dragged) next = keepWhereLeft(next, node);
        return next;
      });
      return;
    }
    const node = dragged[0]!;
    const one = byId.get(node.id);
    if (!one) return;
    const at = absoluteNow(node);

    if (one.kind === 'card') {
      const fromPanel = one.panelId ?? null;
      // Onto another card: ask.
      if (target?.kind === 'card' && point) {
        setBoard((was) => keepWhereLeft(was, node));
        setDropAsk({ x: point.x, y: point.y, targetId: target.id, itemId: one.itemId, fromId: one.id });
        return;
      }
      // Into a box that is not its own: filed there.
      const box = target?.kind === 'box' ? target : target && 'parent' in target ? boxOf(target.parent) : undefined;
      if (box && box.panelId !== fromPanel) {
        if (isFiled(one.itemId, box.panelId)) {
          setNodes((was) => [...was]);
          setBoard((was) => ({ ...was }));
          flash(`c:${box.panelId}:${one.itemId}`);
          return;
        }
        // It takes the next place in the box's grid, so nothing lands on top of a card.
        setBoard((was) => ({ ...was, open: fromPanel ? was.open : was.open.filter((card) => openCardId(card.id) !== one.id) }));
        fileOn(one.itemId, box.panelId, fromPanel);
        return;
      }
      // Within its own box: it stays filed, where it was left.
      if (fromPanel && box?.panelId === fromPanel) {
        setBoard((was) => keepWhereLeft(was, node));
        return;
      }
      // Out of its box onto open space: taken off that Panel.
      if (fromPanel) {
        takeOffPanel(one.itemId, fromPanel);
        const twin = board.open.find((card) => card.itemId === one.itemId);
        setBoard((was) => {
          const inBox = { ...was.inBox, [fromPanel]: { ...was.inBox[fromPanel] } };
          delete inBox[fromPanel]![one.itemId];
          return twin ? { ...was, inBox } : { ...was, inBox, open: [...was.open, { id: newId(), itemId: one.itemId, x: at.x, y: at.y }] };
        });
        if (twin) window.setTimeout(() => flash(openCardId(twin.id)), 50);
        return;
      }
      setBoard((was) => keepWhereLeft(was, node));
      return;
    }

    if (one.kind === 'box') {
      const into = target?.kind === 'box' ? target : target && 'parent' in target ? boxOf(target.parent) : undefined;
      const currentParent = parentOf[one.panelId];
      if (into && into.panelId !== currentParent) {
        // A box let go inside another: its Panel becomes a child of that Panel.
        setParentOf((was) => ({ ...was, [one.panelId]: into.panelId }));
        setBoard((was) => ({ ...was, boxes: { ...was.boxes, [one.panelId]: { ...was.boxes[one.panelId], ...relativeTo(into.panelId, at) } } }));
        return;
      }
      if (!into && currentParent) {
        setParentOf((was) => {
          const next = { ...was };
          delete next[one.panelId];
          return next;
        });
        setBoard((was) => ({ ...was, boxes: { ...was.boxes, [one.panelId]: { ...was.boxes[one.panelId], x: at.x, y: at.y } } }));
        return;
      }
      setBoard((was) => keepWhereLeft(was, node));
      return;
    }
    setBoard((was) => keepWhereLeft(was, node));
  };

  /** Writes back where a node was left, wherever it is kept. */
  const keepWhereLeft = (was: Board3, node: FlowNode): Board3 => {
    const one = byId.get(node.id);
    const at = { x: node.position.x, y: node.position.y };
    if (!one) return was;
    if (one.kind === 'box') return { ...was, boxes: { ...was.boxes, [one.panelId]: { ...was.boxes[one.panelId], ...at } } };
    if (one.kind === 'sketch') return { ...was, sketches: was.sketches.map((s) => (s.id === one.sketch ? { ...s, ...at } : s)) };
    if (one.panelId) return { ...was, inBox: { ...was.inBox, [one.panelId]: { ...was.inBox[one.panelId], [one.itemId]: at } } };
    return { ...was, open: was.open.map((card) => (openCardId(card.id) === one.id ? { ...card, ...at } : card)) };
  };

  // ---- Dropped on a card: put it inside (the card becomes a Panel), or combine ----
  const putInside = (ask: DropAsk) => {
    const target = byId.get(ask.targetId);
    if (target?.kind !== 'card') return;
    const panelId = crypto.randomUUID();
    const title = itemLabel(items.get(target.itemId) ?? { title: 'Panel' });
    run('add_panel', { dashboardId, panelId, name: title.slice(0, 60), kind: 'items' });
    const from = ask.fromId ? byId.get(ask.fromId) : undefined;
    const fromPanel = from?.kind === 'card' ? (from.panelId ?? null) : null;
    // The Panel is new to the server only once add_panel lands, so file a moment later.
    window.setTimeout(() => {
      if (isUuid(ask.itemId)) {
        const order = [ask.itemId];
        if (fromPanel) run('move_item_to_panel', { itemId: ask.itemId, panelId, order, fromPanelIds: [fromPanel] });
        else run('add_item_to_panel', { itemId: ask.itemId, panelId, order });
      }
    }, 400);
    addChildren(workspaceId, target.itemId, [ask.itemId]);
    setPanelItem((was) => ({ ...was, [panelId]: target.itemId }));
    if (colours[`item:${target.itemId}`]) setColours((was) => ({ ...was, [`panel:${panelId}`]: was[`item:${target.itemId}`]! }));
    if (target.panelId) setParentOf((was) => ({ ...was, [panelId]: target.panelId! }));
    setBoard((was) => ({
      ...was,
      open: was.open.filter((card) => openCardId(card.id) !== target.id && (from?.kind === 'card' && !from.panelId ? openCardId(card.id) !== from.id : true)),
      // Inside another box it takes the next free place there; on open space, the card's own.
      boxes: target.panelId ? was.boxes : { ...was.boxes, [panelId]: { x: target.x, y: target.y } },
    }));
  };
  const landBeside = (ask: DropAsk) => {
    const target = byId.get(ask.targetId);
    if (!target) return;
    const spot = { x: target.x + CARD_W + 24, y: target.y };
    const from = ask.fromId ? byId.get(ask.fromId) : undefined;
    if (target.kind === 'card' && target.panelId) {
      // Beside a card in a box is in that box.
      if (from?.kind === 'card' && from.panelId === target.panelId) {
        setBoard((was) => ({ ...was, inBox: { ...was.inBox, [target.panelId!]: { ...was.inBox[target.panelId!], [ask.itemId]: spot } } }));
        return;
      }
      if (!isFiled(ask.itemId, target.panelId)) fileOn(ask.itemId, target.panelId, from?.kind === 'card' ? (from.panelId ?? null) : null);
      setBoard((was) => ({
        ...was,
        open: from && from.kind === 'card' && !from.panelId ? was.open.filter((card) => openCardId(card.id) !== from.id) : was.open,
        inBox: { ...was.inBox, [target.panelId!]: { ...was.inBox[target.panelId!], [ask.itemId]: spot } },
      }));
      return;
    }
    setBoard((was) => {
      if (from?.kind === 'card' && !from.panelId) return { ...was, open: was.open.map((card) => (openCardId(card.id) === from.id ? { ...card, ...spot } : card)) };
      if (was.open.some((card) => card.itemId === ask.itemId)) return was;
      return { ...was, open: [...was.open, { id: newId(), itemId: ask.itemId, ...spot }] };
    });
  };
  const answerDrop = (answer: 'inside' | 'combine' | 'cancel') => {
    const ask = dropAsk;
    setDropAsk(null);
    setDropTargetId(null);
    if (!ask) return;
    const target = byId.get(ask.targetId);
    if (answer === 'inside') putInside(ask);
    else {
      landBeside(ask);
      if (answer === 'combine' && target?.kind === 'card') askToCombine([ask.itemId, target.itemId], dashboardId);
    }
  };

  // ---- Combined on the board: the new parent is a Panel box at the first card's spot, its children in a grid ----
  useEffect(() => {
    if (readOnly) return;
    const onCombined = (event: Event) => {
      const { parentId, title, childIds, nodeIds } = (event as CustomEvent<{ parentId: string; title: string; childIds: string[]; nodeIds: string[] }>).detail;
      const first = byId.get(nodeIds[0] ?? '');
      if (!first || first.kind !== 'card') return;
      const before = { board, parentOf, panelItem };
      const panelId = crypto.randomUUID();
      const sources = nodeIds.flatMap((id) => {
        const one = byId.get(id);
        return one?.kind === 'card' ? [one] : [];
      });
      run('add_panel', { dashboardId, panelId, name: title.slice(0, 60), kind: 'items' });
      window.setTimeout(() => {
        childIds.forEach((itemId, n) => {
          const from = sources.find((one) => one.itemId === itemId)?.panelId ?? null;
          const order = childIds.slice(0, n + 1);
          if (from && isUuid(from)) run('move_item_to_panel', { itemId, panelId, order, fromPanelIds: [from] });
          else run('add_item_to_panel', { itemId, panelId, order });
        });
      }, 400);
      setPanelItem((was) => ({ ...was, [panelId]: parentId }));
      if (first.panelId) setParentOf((was) => ({ ...was, [panelId]: first.panelId! }));
      setBoard((was) => ({
        ...was,
        open: was.open.filter((card) => !nodeIds.includes(openCardId(card.id))),
        boxes: first.panelId ? was.boxes : { ...was.boxes, [panelId]: { x: first.x, y: first.y } },
      }));
      offerToUndo({
        what: `Combined into “${title}”`,
        undo: async () => {
          run('delete_panel', { panelId });
          sources.forEach((one) => one.panelId && fileOn(one.itemId, one.panelId, null));
          dropParent(workspaceId, parentId);
          setBoard(before.board);
          setParentOf(before.parentOf);
          setPanelItem(before.panelItem);
        },
      });
    };
    window.addEventListener('poc-combined', onCombined);
    return () => window.removeEventListener('poc-combined', onCombined);
  });

  // ---- Pointer tools: Box, Line, and an arrow drawn from the menu ----
  const local = (clientX: number, clientY: number) => {
    const rect = wrapper.current!.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  };
  const link = (fromId: string, toId: string) => {
    const a = byId.get(fromId);
    const b = byId.get(toId);
    if (!a || !b || a.id === b.id) return;
    setLinks((was) => [...was, { id: newId(), from: refOf(a), to: refOf(b), kindId: kind.id }]);
  };
  /** A dot dragged to another card or box - its dot, or anywhere on it - links the two. */
  const onConnectEnd = (event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
    const from = state.fromNode?.id;
    if (!from) return;
    const point = 'clientX' in event ? event : event.changedTouches[0];
    const to = state.toNode?.id ?? (point ? nodeUnder(point.clientX, point.clientY, new Set([from])) : null);
    if (to && to !== from) link(from, to);
  };
  const overlayDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const at = local(event.clientX, event.clientY);
    if (arrowFrom) {
      const target = nodeUnder(event.clientX, event.clientY);
      if (target) link(arrowFrom, target);
      setArrowFrom(null);
      setDrawing(null);
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrawing({ tool, x0: at.x, y0: at.y, x1: at.x, y1: at.y });
  };
  const overlayMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const at = local(event.clientX, event.clientY);
    if (arrowFrom) {
      const from = flow.getInternalNode(arrowFrom);
      if (!from) return;
      const s = flow.flowToScreenPosition(centre(from));
      const o = local(s.x, s.y);
      setDrawing({ tool: 'arrow', x0: o.x, y0: o.y, x1: at.x, y1: at.y });
      return;
    }
    if (drawing) setDrawing({ ...drawing, x1: at.x, y1: at.y });
  };
  const overlayUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drawing || arrowFrom) return;
    setDrawing(null);
    const rect = wrapper.current!.getBoundingClientRect();
    const a = flow.screenToFlowPosition({ x: drawing.x0 + rect.left, y: drawing.y0 + rect.top });
    const b = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    setTool('select');
    if (Math.abs(b.x - a.x) < 12 && Math.abs(b.y - a.y) < 12) return;
    if (drawing.tool === 'box') {
      const snap = (v: number) => (grid ? Math.round(v / GRID) * GRID : v);
      // Drawn inside a box: the new Panel is that Panel's child.
      const startedIn = boxOf(nodeUnder(drawing.x0 + rect.left, drawing.y0 + rect.top)) ?? boxOf((byId.get(nodeUnder(drawing.x0 + rect.left, drawing.y0 + rect.top) ?? '') as { parent?: string } | undefined)?.parent);
      const topLeft = { x: snap(Math.min(a.x, b.x)), y: snap(Math.min(a.y, b.y)) };
      const spot = startedIn ? relativeTo(startedIn.panelId, topLeft) : topLeft;
      setPending({ id: `new:${newId()}`, ...spot, w: Math.max(CARD_W + 32, snap(Math.abs(b.x - a.x))), h: Math.max(100, snap(Math.abs(b.y - a.y))), parentPanel: startedIn?.panelId ?? null });
    } else {
      const id = newId();
      setBoard((was) => ({ ...was, lines: [...was.lines, { id, x1: a.x, y1: a.y, x2: b.x, y2: b.y, label: '' }] }));
      setEditingLine(id);
    }
  };
  useEffect(() => {
    if (pending) setEditingId(pending.id);
  }, [pending]);

  // ---- Dropping a row from a Panel, or a whole Panel ----
  const onDragOver = (event: React.DragEvent) => {
    if (readOnly || !event.dataTransfer.types.includes(ITEM_BEING_DRAGGED)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const under = nodeUnder(event.clientX, event.clientY);
    if (under !== dropTargetId) setDropTargetId(under);
  };
  const onDrop = (event: React.DragEvent) => {
    if (readOnly || !event.dataTransfer.types.includes(ITEM_BEING_DRAGGED)) return;
    event.preventDefault();
    const target = dropTargetId ? byId.get(dropTargetId) : undefined;
    setDropTargetId(null);
    const itemId = event.dataTransfer.getData(ITEM_BEING_DRAGGED);
    if (!itemId) return;
    const carried = selectionCarried();
    const ids = carried?.ids.includes(itemId) ? [...carried.ids] : [itemId];
    const at = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    if (ids.length === 1 && target?.kind === 'card' && target.itemId !== itemId) {
      setDropTargetId(target.id);
      setDropAsk({ x: event.clientX, y: event.clientY, targetId: target.id, itemId, fromId: null });
      return;
    }
    const box = target?.kind === 'box' ? target : target && 'parent' in target ? boxOf(target.parent) : undefined;
    if (box) {
      ids.forEach((id) => {
        if (isFiled(id, box.panelId)) {
          flash(`c:${box.panelId}:${id}`);
          return;
        }
        fileOn(id, box.panelId, null);
      });
      return;
    }
    ids.forEach((id, n) => {
      const twin = board.open.find((card) => card.itemId === id);
      if (twin) {
        flash(openCardId(twin.id));
        return;
      }
      setBoard((was) => ({ ...was, open: [...was.open, { id: newId(), itemId: id, x: at.x - CARD_W / 2, y: at.y - CARD_H / 2 + n * (CARD_H + 12) }] }));
    });
  };
  useEffect(() => {
    if (readOnly) return;
    const onPanel = (event: Event) => {
      const { panelId } = (event as CustomEvent<{ panelId: string }>).detail;
      if (byId.has(boxId(panelId))) flash(boxId(panelId));
    };
    window.addEventListener('poc-panel-drop', onPanel);
    return () => window.removeEventListener('poc-panel-drop', onPanel);
  }, [readOnly, byId, flash]);

  // ---- Keys ----
  const selected = nodes.filter((node) => node.selected);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing = event.target instanceof HTMLElement && /INPUT|TEXTAREA/.test(event.target.tagName);
      if (typing || document.querySelector('[role="dialog"]') || document.querySelector('[role="menu"]')) return;
      const onBoard = wrapper.current?.contains(document.activeElement ?? null);
      if (event.key === 'Escape') {
        if (dropAsk) {
          answerDrop('cancel');
          return;
        }
        setMenu(null);
        setEdgePop(null);
        setArrowFrom(null);
        setDrawing(null);
        fitAll();
      }
      if (!onBoard || selected.length !== 1) return;
      const id = selected[0]!.id;
      if (event.key === 'Enter') {
        event.preventDefault();
        open(id);
      } else if (event.key === 'F2') {
        event.preventDefault();
        startRename(id);
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        const one = byId.get(id);
        if (one?.kind === 'box') setDeleting(one.panelId);
        else takeOff(id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  /** A double-click opens only when both clicks hit the same thing, in time, with no key held. */
  const onNodeClick = (event: React.MouseEvent, node: FlowNode) => {
    setMenu(null);
    setEdgePop(null);
    if (readOnly) {
      open(node.id);
      return;
    }
    if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) {
      lastClick.current = null;
      return;
    }
    const now = performance.now();
    const last = lastClick.current;
    if (last && last.id === node.id && now - last.at < DOUBLE_MS) {
      lastClick.current = null;
      if (renameLater.current) window.clearTimeout(renameLater.current);
      renameLater.current = null;
      open(node.id);
      return;
    }
    lastClick.current = { id: node.id, at: now };
  };
  const onDoubleClickPane = (event: React.MouseEvent) => {
    if (readOnly || tool !== 'select' || event.shiftKey || event.metaKey || event.ctrlKey) return;
    if (!(event.target instanceof Element) || !event.target.classList.contains('react-flow__pane')) return;
    const at = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const id = newId();
    setBoard((was) => ({ ...was, sketches: [...was.sketches, { id, title: '', x: at.x - CARD_W / 2, y: at.y - CARD_H / 2 }] }));
    window.setTimeout(() => setEditingId(sketchId(id)), 0);
  };

  const selectedCards = selected.flatMap((node) => {
    const one = byId.get(node.id);
    return one?.kind === 'card' ? [one] : [];
  });
  const menuNode = menu?.nodeId ? byId.get(menu.nodeId) : undefined;
  const editingFree = board.lines.find((line) => line.id === editingLine);
  const popLink = edgePop ? links.find((one) => one.id === edgePop.linkId) : undefined;
  const askTarget = dropAsk ? byId.get(dropAsk.targetId) : undefined;
  const nameOf = (one: Placed) => (one.kind === 'box' ? panelName(one.panelId) : one.kind === 'card' ? itemLabel(items.get(one.itemId) ?? { title: 'Item' }) : one.title || 'Sketch');

  const chip = 'flex items-center gap-1 rounded-md border border-shade/10 bg-surface p-1 shadow-md';
  const small = 'rounded px-2 py-1 text-xs text-ink hover:bg-accent-tint';
  const floating = 'fixed z-floating min-w-48 rounded-md border border-shade/10 bg-surface p-1 shadow-lg';
  const entryClass = 'block w-full rounded px-3 py-1.5 text-left text-sm text-ink hover:bg-accent-tint hover:text-accent-deep';
  const tip = (label: string, icon: ReactNode, text: string) => (narrow ? <span title={label} className="flex items-center">{icon}</span> : text);

  /** The board's own entries for a card, after the row's menu. */
  const extrasFor = (nodeId: string) => (M: Parameters<NonNullable<React.ContextType<typeof PocRowExtras>>>[0]) => {
    const one = byId.get(nodeId);
    if (one?.kind !== 'card') return null;
    return (
      <>
        <M.Item className="block w-full cursor-default rounded px-3 py-1.5 text-left text-sm text-ink outline-none data-[highlighted]:bg-accent-tint" onSelect={() => setArrowFrom(nodeId)}>
          Draw arrow from here
        </M.Item>
        {!one.panelId && (
          <M.Item className="block w-full cursor-default rounded px-3 py-1.5 text-left text-sm text-ink outline-none data-[highlighted]:bg-accent-tint" onSelect={() => takeOff(nodeId)}>
            Take off the whiteboard
          </M.Item>
        )}
      </>
    );
  };

  const boxEntries = (one: Extract<Placed, { kind: 'box' }>): [string, () => void, boolean?][] => [
    ...(panelItem[one.panelId] ? ([['Open', () => openItem(panelItem[one.panelId]!)]] as [string, () => void][]) : [['Show in the Panels', () => showPanel(one.panelId)] as [string, () => void]]),
    ['Rename', () => startRename(one.id)],
    ['Colour…', () => setColourFor({ x: menu!.x, y: menu!.y, key: `panel:${one.panelId}` })],
    [one.collapsed ? 'Expand' : 'Collapse', () => toggleCollapsed(one.id)],
    ...(one.collapsed ? [] : ([['Zoom to box', () => zoomTo(one.id)]] as [string, () => void][])),
    ['Draw arrow from here', () => setArrowFrom(one.id)],
    [`Delete Panel ${panelName(one.panelId)}…`, () => setDeleting(one.panelId), true],
  ];

  return (
    <BoardContext.Provider value={ctx}>
      <style>{`
        [data-poc-whiteboard] .poc-dot { width: 10px; height: 10px; background: var(--color-surface); border: 2px solid var(--color-accent); opacity: 0; transition: opacity .12s; }
        [data-poc-whiteboard] .react-flow__node:hover > div > .poc-dot, [data-poc-whiteboard] .react-flow__node.selected > div > .poc-dot { opacity: 1; }
        [data-poc-whiteboard] .poc-dot:hover { background: var(--color-accent); }
      `}</style>
      <div
        ref={wrapper}
        data-poc-whiteboard
        onDragOver={onDragOver}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as globalThis.Node | null)) setDropTargetId(null);
        }}
        onDrop={onDrop}
        onDoubleClick={onDoubleClickPane}
        className={`${full ? 'fixed inset-0 z-floating' : 'relative h-full w-full'} overflow-hidden rounded-md border border-shade/10 bg-surface`}
      >
        <ReactFlow<FlowNode, KindEdge>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnectEnd={onConnectEnd}
          connectionMode={ConnectionMode.Loose}
          onNodeDrag={onNodeDrag}
          onNodeDragStop={onNodeDragStop}
          onNodeClick={onNodeClick}
          onNodeContextMenu={(event, node) => {
            if (readOnly) return;
            event.preventDefault();
            const one = byId.get(node.id);
            if (one?.kind === 'card' && !items.has(one.itemId)) return;
            if (one?.kind === 'card') setRowMenu((was) => ({ x: event.clientX, y: event.clientY, nodeId: node.id, itemId: one.itemId, panelId: one.panelId ?? null, n: (was?.n ?? 0) + 1 }));
            else setMenu({ x: event.clientX, y: event.clientY, nodeId: node.id });
          }}
          onPaneContextMenu={(event) => {
            if (readOnly) return;
            event.preventDefault();
            setMenu({ x: event.clientX, y: event.clientY, nodeId: null });
          }}
          onPaneClick={() => {
            setMenu(null);
            setEdgePop(null);
            if (dropAsk) answerDrop('cancel');
          }}
          onEdgeClick={(event, edge) => {
            if (readOnly || !edge.data) return;
            setEdgePop({ x: event.clientX, y: event.clientY, linkId: edge.data.linkId });
          }}
          onEdgeMouseEnter={(_, edge) => setHoveredEdge(edge.id)}
          onEdgeMouseLeave={() => setHoveredEdge(null)}
          minZoom={0.1}
          maxZoom={2.5}
          zoomOnDoubleClick={false}
          elevateNodesOnSelect={false}
          snapToGrid={grid}
          snapGrid={[GRID, GRID]}
          nodesDraggable={!readOnly}
          nodesConnectable={!readOnly}
          elementsSelectable={!readOnly}
          panOnDrag
          panOnScroll={!readOnly}
          zoomActivationKeyCode={['Meta', 'Control']}
          selectionKeyCode={readOnly ? null : 'Shift'}
          selectionMode={SelectionMode.Partial}
          multiSelectionKeyCode={['Shift', 'Meta', 'Control']}
          deleteKeyCode={null}
          proOptions={{ hideAttribution: true }}
        >
          {grid && <Background variant={BackgroundVariant.Dots} gap={GRID} size={1.4} color="#c3c6d4" />}
          <ViewportPortal>
            <svg className="pointer-events-none absolute overflow-visible" style={{ left: 0, top: 0, width: 1, height: 1 }}>
              {board.lines.map((line) => (
                <g key={line.id}>
                  <line x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2} stroke="#8b8d94" strokeWidth={2} strokeDasharray="10 6" />
                  <line
                    x1={line.x1}
                    y1={line.y1}
                    x2={line.x2}
                    y2={line.y2}
                    stroke="transparent"
                    strokeWidth={14}
                    style={{ pointerEvents: readOnly ? 'none' : 'stroke', cursor: 'pointer' }}
                    onDoubleClick={() => setEditingLine(line.id)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      if (confirm('Take this line off the whiteboard?')) setBoard((was) => ({ ...was, lines: was.lines.filter((one) => one.id !== line.id) }));
                    }}
                  />
                </g>
              ))}
            </svg>
            {board.lines.map((line) =>
              line.label || editingLine === line.id ? (
                <div
                  key={line.id}
                  className="absolute whitespace-nowrap px-1 text-xs font-semibold tracking-wide text-ink-soft"
                  style={{ left: (line.x1 + line.x2) / 2, top: (line.y1 + line.y2) / 2, transform: 'translate(-50%, -50%)', pointerEvents: 'all', background: 'var(--color-surface)' }}
                  onDoubleClick={() => !readOnly && setEditingLine(line.id)}
                  data-line-label={line.label}
                >
                  {editingLine === line.id && editingFree ? (
                    <input
                      autoFocus
                      defaultValue={line.label}
                      placeholder="Label (optional)"
                      aria-label="Label this line"
                      className="nodrag w-36 bg-transparent outline-none"
                      onKeyDown={(event) => {
                        event.stopPropagation();
                        if (event.key === 'Enter' || event.key === 'Escape') (event.target as HTMLInputElement).blur();
                      }}
                      onBlur={(event) => {
                        const label = event.target.value.trim();
                        setEditingLine(null);
                        setBoard((was) => ({ ...was, lines: was.lines.map((one) => (one.id === line.id ? { ...one, label } : one)) }));
                      }}
                    />
                  ) : (
                    line.label
                  )}
                </div>
              ) : null,
            )}
            {pending && (
              // A box being drawn, named before it becomes a Panel.
              <div
                className="absolute rounded-lg border-2 border-dashed border-accent bg-accent-tint/30 p-2"
                style={{
                  left: (pending.parentPanel ? absoluteOf(placed, boxId(pending.parentPanel)).x : 0) + pending.x,
                  top: (pending.parentPanel ? absoluteOf(placed, boxId(pending.parentPanel)).y : 0) + pending.y,
                  width: pending.w,
                  height: pending.h,
                  pointerEvents: 'all',
                }}
              >
                <div className="flex">
                  <InlineName id={pending.id} initial="" placeholder="Name the new Panel" className="text-sm font-semibold" />
                </div>
              </div>
            )}
          </ViewportPortal>
        </ReactFlow>

        {!readOnly && (tool !== 'select' || arrowFrom) && (
          <div className="absolute inset-0 z-10 cursor-crosshair" data-poc-overlay={tool} onPointerDown={overlayDown} onPointerMove={overlayMove} onPointerUp={overlayUp}>
            {drawing && (
              <svg className="pointer-events-none absolute inset-0 h-full w-full">
                {drawing.tool === 'box' ? (
                  <rect
                    x={Math.min(drawing.x0, drawing.x1)}
                    y={Math.min(drawing.y0, drawing.y1)}
                    width={Math.abs(drawing.x1 - drawing.x0)}
                    height={Math.abs(drawing.y1 - drawing.y0)}
                    rx={10}
                    fill="rgb(111 98 181 / 0.08)"
                    stroke="var(--color-accent)"
                    strokeWidth={2}
                  />
                ) : (
                  <line
                    x1={drawing.x0}
                    y1={drawing.y0}
                    x2={drawing.x1}
                    y2={drawing.y1}
                    stroke={drawing.tool === 'line' ? '#8b8d94' : kind.colour}
                    strokeWidth={2}
                    strokeDasharray={drawing.tool === 'line' ? '10 6' : DASHES[kind.style]}
                  />
                )}
              </svg>
            )}
            {arrowFrom && (
              <p className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded bg-toast px-3 py-1 text-xs text-white">Click the card or box it goes to · Esc to stop</p>
            )}
          </div>
        )}

        {!readOnly && (
          <div className={`absolute top-3 left-3 z-20 ${chip}`} role="toolbar" aria-label="Whiteboard tools">
            {(
              [
                ['select', 'Select', <svg key="i" viewBox="0 0 16 16" className="size-4" fill="currentColor" aria-hidden="true"><path d="M3 2l9 5-4 1-2 4z" /></svg>],
                ['box', 'Box (a new Panel)', <svg key="i" viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="2.5" y="3.5" width="11" height="9" rx="1.5" /></svg>],
                ['line', 'Line', <svg key="i" viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray="3 2" aria-hidden="true"><path d="M2 13 14 3" /></svg>],
              ] as [Tool, string, ReactNode][]
            ).map(([value, label, icon]) => (
              <button
                key={value}
                type="button"
                aria-label={label}
                title={label}
                aria-pressed={tool === value}
                onClick={() => {
                  setTool(value);
                  setArrowFrom(null);
                }}
                className={`rounded px-2 py-1 text-xs ${tool === value ? 'bg-accent text-on-accent' : 'text-ink hover:bg-accent-tint'}`}
              >
                {narrow ? icon : label.replace(' (a new Panel)', '')}
              </button>
            ))}
            <span className="mx-1 h-4 w-px bg-shade/15" />
            <KindPicker kinds={kinds} kind={kind} compact={narrow} onPick={setKindId} onAdd={(made) => (setKinds([...kinds, made]), setKindId(made.id))} />
            <span className="mx-1 h-4 w-px bg-shade/15" />
            <button type="button" aria-label="Show labels" title="Show labels" aria-pressed={showLabels} onClick={() => setShowLabels(!showLabels)} className={`${small} ${showLabels ? 'bg-accent-tint text-accent-deep' : ''}`}>
              {tip('Show labels', <span className="text-[11px] font-semibold">Aa</span>, 'Show labels')}
            </button>
            <button type="button" aria-label={`Grid: ${grid ? 'on' : 'off'}`} title={`Grid: ${grid ? 'on' : 'off'}`} aria-pressed={grid} onClick={() => setGrid(!grid)} className={`${small} ${grid ? '' : 'opacity-60'}`}>
              {tip(`Grid: ${grid ? 'on' : 'off'}`, <span className="text-[13px]">⋯</span>, `Grid: ${grid ? 'on' : 'off'}`)}
            </button>
          </div>
        )}

        <div className={`absolute top-3 right-3 z-20 ${chip}`} role="toolbar" aria-label="Zoom">
          <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => void flow.zoomOut({ duration: 200 })} className={small}>
            −
          </button>
          {!narrow && <span className="w-11 text-center text-xs tabular-nums text-ink-soft">{Math.round(zoom * 100)}%</span>}
          <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => void flow.zoomIn({ duration: 200 })} className={small}>
            +
          </button>
          <button type="button" aria-label="Fit" title="Fit" onClick={fitAll} className={small}>
            {tip('Fit', <span>⤢</span>, 'Fit')}
          </button>
          <button type="button" aria-label={full ? 'Exit full screen' : 'Full screen'} title={full ? 'Exit full screen' : 'Full screen'} onClick={() => setFull(!full)} className={small}>
            {tip(full ? 'Exit full screen' : 'Full screen', <span>⛶</span>, full ? 'Exit full screen' : 'Full screen')}
          </button>
        </div>

        {!readOnly && selectedCards.length >= 2 && (
          <div className={`absolute top-14 left-1/2 z-20 -translate-x-1/2 ${chip}`} aria-label="Selection">
            <span className="px-2 text-xs text-ink-soft">{selected.length} selected</span>
            <button
              type="button"
              onClick={() => askToCombine(selectedCards.flatMap((card) => (card.kind === 'card' ? [card.itemId] : [])), dashboardId, selectedCards.map((card) => card.id))}
              className="milled rounded bg-accent px-2.5 py-1 text-xs font-medium text-on-accent hover:bg-accent-hover"
            >
              Combine
            </button>
          </div>
        )}

        {placed.length === 0 && !readOnly && (
          <p className="pointer-events-none absolute inset-x-0 top-1/2 text-center text-sm text-ink-faint">Drag a row here, draw a Box to make a Panel, or double-click to sketch.</p>
        )}
      </div>

      {/* A card's menu is its row's own menu, drawn by a row kept out of sight, with the board's entries after it. */}
      {rowMenu &&
        createPortal(
          <div
            key={rowMenu.n}
            aria-hidden="true"
            className="pointer-events-none fixed w-[320px] opacity-0"
            style={{ left: rowMenu.x, top: rowMenu.y }}
            ref={(el) => {
              if (!el || el.dataset.opened) return;
              const tryOpen = (tries: number) => {
                const row = el.querySelector('li');
                if (!row) {
                  if (tries < 40) window.setTimeout(() => tryOpen(tries + 1), 25);
                  return;
                }
                el.dataset.opened = '1';
                row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rowMenu.x, clientY: rowMenu.y, button: 2 }));
              };
              tryOpen(0);
            }}
          >
            <PocRowExtras.Provider value={extrasFor(rowMenu.nodeId)}>
              <Suspense fallback={null}>
                <ItemList
                  workspaceId={workspaceId}
                  items={items.has(rowMenu.itemId) ? [items.get(rowMenu.itemId)!] : []}
                  openDashboardId={dashboardId}
                  panelId={rowMenu.panelId}
                  gathered={!rowMenu.panelId}
                  emptyMessage=""
                />
              </Suspense>
            </PocRowExtras.Provider>
          </div>,
          document.body,
        )}
      {menu &&
        createPortal(
          <div role="menu" className={floating} style={{ left: menu.x, top: menu.y }} onContextMenu={(event) => event.preventDefault()}>
            {(menuNode?.kind === 'box'
              ? boxEntries(menuNode)
              : menuNode?.kind === 'sketch'
                ? ([
                    ['Rename', () => startRename(menuNode.id)],
                    ['Draw arrow from here', () => setArrowFrom(menuNode.id)],
                    ['Take off the whiteboard', () => takeOff(menuNode.id), true],
                  ] as [string, () => void, boolean?][])
                : ([
                    ['Fit everything', fitAll],
                    ['New Panel here (Box tool)', () => setTool('box')],
                  ] as [string, () => void, boolean?][])
            ).map(([label, act, destructive]) => (
              <button
                key={label}
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenu(null);
                  act();
                }}
                className={`${entryClass} ${destructive ? 'text-over-ink' : ''}`}
              >
                {label}
              </button>
            ))}
          </div>,
          document.body,
        )}
      {colourFor &&
        createPortal(
          <>
            <div className="fixed inset-0 z-floating" onPointerDown={() => setColourFor(null)} />
            <div className={`${floating} w-56`} style={{ left: colourFor.x, top: colourFor.y }} aria-label="Colour">
              <Swatches
                current={colours[colourFor.key]}
                onPick={(colour) => {
                  setColours((was) => {
                    const next = { ...was };
                    if (colour) next[colourFor.key] = colour;
                    else delete next[colourFor.key];
                    return next;
                  });
                  setColourFor(null);
                }}
              />
            </div>
          </>,
          document.body,
        )}
      {deleting &&
        createPortal(
          <>
            <div className="fixed inset-0 z-floating bg-scrim/30" onPointerDown={() => setDeleting(null)} />
            <div role="alertdialog" aria-label="Delete Panel" className="fixed top-1/2 left-1/2 z-floating w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-shade/10 bg-surface p-5 shadow-lg">
              <p className="text-base font-semibold">Delete Panel {panelName(deleting)}?</p>
              <p className="pt-2 text-sm text-ink-soft">Its Items stay in the Workspace; any on no other Panel go back to the Inbox.</p>
              <div className="flex justify-end gap-2 pt-5">
                <button type="button" onClick={() => setDeleting(null)} className="rounded-md border border-shade/10 px-3 py-1.5 text-sm text-ink-soft hover:bg-accent-tint">
                  Cancel
                </button>
                <button type="button" onClick={() => deletePanel(deleting)} className="rounded-md bg-over px-3 py-1.5 text-sm font-medium text-white">
                  Delete Panel
                </button>
              </div>
            </div>
          </>,
          document.body,
        )}
      {dropAsk &&
        askTarget &&
        createPortal(
          <>
            <div className="fixed inset-0 z-floating" onPointerDown={() => answerDrop('cancel')} />
            <div role="menu" aria-label="Dropped on an Item" className={floating} style={{ left: dropAsk.x + 4, top: dropAsk.y + 4 }}>
              <button type="button" role="menuitem" onClick={() => answerDrop('inside')} className={entryClass}>
                Put inside {nameOf(askTarget)}
              </button>
              <button type="button" role="menuitem" onClick={() => answerDrop('combine')} className={entryClass}>
                Combine with {nameOf(askTarget)}…
              </button>
            </div>
          </>,
          document.body,
        )}
      {edgePop &&
        popLink &&
        createPortal(
          <div className={`${floating} w-56 p-2`} style={{ left: edgePop.x + 6, top: edgePop.y + 6 }} aria-label="Link">
            <p className="px-1 pb-1 text-xs font-semibold tracking-[0.12em] text-accent-deep uppercase">Kind</p>
            {kinds.map((one) => (
              <button
                key={one.id}
                type="button"
                onClick={() => setLinks((was) => was.map((l) => (l.id === popLink.id ? { ...l, kindId: one.id } : l)))}
                className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-accent-tint ${one.id === popLink.kindId ? 'font-medium text-accent-deep' : 'text-ink'}`}
              >
                <KindSample kind={one} />
                {one.name}
              </button>
            ))}
            <input
              defaultValue={popLink.label ?? ''}
              placeholder="Label (optional)"
              aria-label="Label of this link"
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === 'Enter' || event.key === 'Escape') setEdgePop(null);
              }}
              onChange={(event) => {
                const label = event.target.value.trim() || undefined;
                setLinks((was) => was.map((l) => (l.id === popLink.id ? { ...l, label } : l)));
              }}
              className="mt-2 w-full rounded-md border border-shade/10 bg-field px-2 py-1 text-sm outline-none focus:border-accent"
            />
            <button
              type="button"
              onClick={() => {
                setLinks((was) => was.filter((l) => l.id !== popLink.id));
                setEdgePop(null);
              }}
              className="mt-1 w-full rounded px-2 py-1 text-left text-sm text-over-ink hover:bg-accent-tint"
            >
              Remove link
            </button>
          </div>,
          document.body,
        )}
    </BoardContext.Provider>
  );
}

function KindSample({ kind, width = 28 }: { kind: Pick<LineKind, 'style' | 'colour' | 'arrow'>; width?: number }) {
  return (
    <svg width={width} height={10} aria-hidden="true" className="shrink-0">
      {kind.style === 'double' ? (
        <>
          <line x1={1} y1={3} x2={width - 6} y2={3} stroke={kind.colour} strokeWidth={1.5} />
          <line x1={1} y1={7} x2={width - 6} y2={7} stroke={kind.colour} strokeWidth={1.5} />
        </>
      ) : (
        <line x1={1} y1={5} x2={width - 6} y2={5} stroke={kind.colour} strokeWidth={2} strokeDasharray={DASHES[kind.style]} strokeLinecap="round" />
      )}
      {kind.arrow && <path d={`M${width - 7} 1 L${width - 1} 5 L${width - 7} 9 Z`} fill={kind.colour} />}
    </svg>
  );
}

function KindPicker({ kinds, kind, compact, onPick, onAdd }: { kinds: LineKind[]; kind: LineKind; compact: boolean; onPick: (id: string) => void; onAdd: (kind: LineKind) => void }) {
  const [open, setOpen] = useState(false);
  const [making, setMaking] = useState(false);
  const [name, setName] = useState('');
  const [style, setStyle] = useState<LineStyle>('dashed');
  const [colour, setColour] = useState(SWATCHES[1]!);
  const [arrow, setArrow] = useState(true);
  return (
    <Popover.Root
      open={open}
      onOpenChange={(now) => {
        setOpen(now);
        if (!now) setMaking(false);
      }}
    >
      <Popover.Trigger className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-ink hover:bg-accent-tint" aria-label="Line kind" title={`Line kind: ${kind.name}`}>
        <KindSample kind={kind} />
        {!compact && `${kind.name} ▾`}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={6} className="z-floating w-60 rounded-md border border-shade/10 bg-surface p-1 shadow-lg">
          {!making ? (
            <>
              {kinds.map((one) => (
                <button
                  key={one.id}
                  type="button"
                  onClick={() => {
                    onPick(one.id);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent-tint ${one.id === kind.id ? 'font-medium text-accent-deep' : 'text-ink'}`}
                >
                  <KindSample kind={one} />
                  {one.name}
                </button>
              ))}
              <div className="my-1 h-px bg-shade/10" />
              <button type="button" onClick={() => setMaking(true)} className="w-full rounded px-2 py-1.5 text-left text-sm text-accent-deep hover:bg-accent-tint">
                + New kind…
              </button>
            </>
          ) : (
            <form
              className="flex flex-col gap-2 p-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (!name.trim()) return;
                onAdd({ id: newId(), name: name.trim(), style, colour, arrow });
                setName('');
                setMaking(false);
                setOpen(false);
              }}
            >
              <input
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => event.stopPropagation()}
                placeholder="Name, e.g. Blocks"
                aria-label="Name of the line kind"
                className="rounded-md border border-shade/10 bg-field px-2 py-1 text-sm outline-none focus:border-accent"
              />
              <div className="grid grid-cols-4 gap-1" role="radiogroup" aria-label="Style">
                {(['solid', 'dashed', 'dotted', 'double'] as const).map((one) => (
                  <button
                    key={one}
                    type="button"
                    role="radio"
                    aria-checked={style === one}
                    aria-label={one}
                    onClick={() => setStyle(one)}
                    className={`flex flex-col items-center gap-0.5 rounded border px-1 py-1 text-[10px] ${style === one ? 'border-accent bg-accent-tint' : 'border-shade/10'}`}
                  >
                    <KindSample kind={{ style: one, colour, arrow: false }} width={30} />
                    {one}
                  </button>
                ))}
              </div>
              <div className="flex gap-1.5" role="radiogroup" aria-label="Colour">
                {SWATCHES.map((one) => (
                  <button
                    key={one}
                    type="button"
                    role="radio"
                    aria-checked={colour === one}
                    aria-label={`Colour ${one}`}
                    onClick={() => setColour(one)}
                    className={`size-5 rounded-full ${colour === one ? 'ring-2 ring-accent ring-offset-2' : ''}`}
                    style={{ background: one }}
                  />
                ))}
              </div>
              <label className="flex items-center gap-2 text-sm text-ink">
                <input type="checkbox" checked={arrow} onChange={(event) => setArrow(event.target.checked)} className="accent-[var(--color-accent)]" />
                Arrowhead
              </label>
              <div className="flex justify-end gap-1">
                <button type="button" onClick={() => setMaking(false)} className="rounded px-2 py-1 text-xs text-ink-soft hover:bg-accent-tint">
                  Cancel
                </button>
                <button type="submit" className="milled rounded bg-accent px-2 py-1 text-xs font-medium text-on-accent">
                  Add kind
                </button>
              </div>
            </form>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export default function Whiteboard(props: { workspaceId: string; dashboardId: string; readOnly: boolean }) {
  return (
    <ReactFlowProvider>
      <BoardInner {...props} />
    </ReactFlowProvider>
  );
}
