import '@xyflow/react/dist/style.css';
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  MarkerType,
  NodeResizer,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  ViewportPortal,
  applyNodeChanges,
  useNodesInitialized,
  useReactFlow,
  useViewport,
  type FinalConnectionState,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { childIdsOf, itemLabel, uuidv7, type ChildRow, type Item } from '@cockpit/shared';
import { SWATCHES, type BoardBox, type BoardCard as PlacedCard, type BoardLine, type LineKind, type Swatch } from '@cockpit/shared/board';
import { useLatestSnapshot, useSendCommand, whyNotDone, type CommandArgs } from '../api/queries';
import { useSnapshot } from '../api/useSnapshot';
import { cardWanted, selectedOnTheBoard, takeUnfolds, useCardWanted } from '../boardFocus';
import { addAsChildren } from '../components/AddAsChildOf';
import { DeleteQuestion } from '../components/DeleteQuestion';
import { useAddingAsChild } from '../components/useAddingAsChild';
import { ItemList } from '../components/ItemList';
import { ITEM_BEING_DRAGGED } from '../dropAt';
import { useOpenItem } from '../itemForm';
import { panelLiftedFrom, parentLiftedFrom, selectionCarried } from '../itemInTheAir';
import { dashboardScope, useSelection } from '../selection';
import { useUndo } from '../undo';
import { BoardCard } from './BoardCard';
import { Dots, FreeLines, LineBeingDrawn, edgeTypes, type LinkEdge } from './BoardLinks';
import { KindPicker, KindSample, type KindFields } from './LineKinds';
import { DASHES, kindsOrFixed, lineInk, linksOnTheBoard } from './links';
import { BoardToolbar, type Tool } from './BoardToolbar';
import { cardUnder, clickRenames, dropAnswers, f2Renames, offeredWithItsCard, pickedOnTheBoard, renameStillWanted } from './gestures';
import { BOX_HEAD, CARD_W, GRID, MIN_BOX, boardOf, boxAt, boxesWithin, hiddenByCollapse, originOf, relativeTo, whyNotPlaceable, type Board } from './layout';
import './boardDrawn';

/**
 * A Dashboard's whiteboard ("Brainstorming: give every Dashboard a whiteboard
 * of its own", issue 1829): cards placed from its Panels and boxes drawn on it,
 * each its own row in the Workspace's read, drawn with `@xyflow/react` in a
 * chunk of its own. It starts empty, holds no Panel and is never an Item.
 * Every change is a command drawn the moment it is made (`boardDrawn.ts`).
 *
 * Gestures: a click selects, Shift-, Ctrl- or Cmd-click toggles and Shift-drag
 * draws a selection rectangle; a double-click on the same card with no key held
 * opens its Item. A left-drag on empty space, Space-drag, a middle-drag or a
 * trackpad scroll pans; Ctrl/Cmd+scroll zooms. On a phone the board is to look
 * at: it opens at a readable zoom and a tap opens the Item.
 *
 * "Brainstorming: cards on the whiteboard can't be nested, combined or moved
 * between boxes" (issue 1830): **a card dropped on a card** - a row from the
 * Panels or another card - offers *Put inside* (the Item joins it as a child
 * and shows in its unfolded card) or *Combine with…*; a card dropped anywhere
 * else moves between boxes and open space and files nothing; *Take off the
 * whiteboard* is in a card's menu; and a selected card's title or a box's name
 * renames in place from a click on it or F2.
 *
 * "Brainstorming: the whiteboard can't show how Items connect" (issue 1831):
 * **a card shows a dot on each side on hover**, and a dot dragged to another
 * card links their Items with the kind the toolbar's picker holds. Every link
 * between two Items drawn here is drawn, under the cards; a click on one
 * changes its kind or label or removes it. **Draw line** draws a free line,
 * which belongs to this board alone.
 */

type CardData = { itemId: string };
type BoxData = { box: BoardBox };
type CardNode = Node<CardData, 'card'>;
type BoxNode = Node<BoxData, 'box'>;
type FlowNode = CardNode | BoxNode;

const PHONE_ZOOM = 0.8;
const DOUBLE_MS = 350;
const NARROW = 700;

interface Ctx {
  readOnly: boolean;
  items: ReadonlyMap<string, Item>;
  childrenOf: (itemId: string) => Item[];
  sourceNames: Record<string, string> | undefined;
  now: number;
  unfolded: ReadonlySet<string>;
  flashId: string | null;
  /** The card a dragged card or row would be dropped on, ringed. */
  dropTargetId: string | null;
  renamingId: string | null;
  /** A press on a title: whether its card or box was selected before the press, which is what a second click renames. */
  titlePressed: (event: React.PointerEvent, wasSelected: boolean) => void;
  /** A click on a title that was selected: renames it, a card's a moment later unless it turns out to be a double-click that opens it. */
  titleClicked: (id: string, kind: 'card' | 'box', event: React.MouseEvent) => void;
  renameCard: (item: Item, title: string | null) => void;
  toggleUnfolded: (itemId: string) => void;
  cardMenu: (cardId: string, at: { x: number; y: number }) => void;
  boxMenu: (boxId: string, at: { x: number; y: number }) => void;
  openItem: (itemId: string) => void;
  toggleCollapsed: (box: BoardBox) => void;
  zoomTo: (nodeId: string) => void;
  startRenaming: (boxId: string) => void;
  rename: (box: BoardBox, label: string | null) => void;
  resized: (box: BoardBox, frame: { x: number; y: number; width: number; height: number }) => void;
}
const BoardContext = createContext<Ctx | null>(null);
const useBoard = () => useContext(BoardContext)!;

const ink = (colour: Swatch) => `var(--color-cat-${colour})`;
const tint = (colour: Swatch) => `var(--color-cat-${colour}-tint)`;

function CardView({ id, data, selected }: NodeProps<CardNode>) {
  const ctx = useBoard();
  const item = ctx.items.get(data.itemId);
  if (!item) return null;
  return (
    <div
      data-card-id={id}
      className={`rounded-md ${ctx.flashId === id ? 'ring-4 ring-accent animate-pulse' : ctx.dropTargetId === id ? 'ring-4 ring-accent/60' : selected ? 'ring-2 ring-accent' : ''}`}
    >
      <Dots readOnly={ctx.readOnly} />
      <BoardCard
        item={item}
        sourceNames={ctx.sourceNames}
        now={ctx.now}
        children={ctx.childrenOf(item.id)}
        unfolded={ctx.unfolded.has(item.id)}
        onUnfold={() => ctx.toggleUnfolded(item.id)}
        {...(ctx.readOnly ? {} : { onMenu: (at: { x: number; y: number }) => ctx.cardMenu(id, at) })}
        onOpenChild={ctx.openItem}
        {...(ctx.readOnly
          ? {}
          : {
              titleProps: {
                onPointerDownCapture: (event: React.PointerEvent) => ctx.titlePressed(event, Boolean(selected)),
                onClick: (event: React.MouseEvent) => ctx.titleClicked(id, 'card', event),
              },
            })}
        renaming={
          ctx.renamingId === id ? <BoxName initial={item.title} placeholder="Title" onDone={(title) => ctx.renameCard(item, title)} /> : null
        }
      />
    </div>
  );
}

/** A box's name typed in its header: as it is drawn, or renamed. Enter or leaving it keeps it, Escape does not. */
function BoxName({ initial, placeholder, onDone }: { initial: string; placeholder: string; onDone: (label: string | null) => void }) {
  const [text, setText] = useState(initial);
  const done = useRef(false);
  const finish = (keep: boolean) => {
    if (done.current) return;
    done.current = true;
    onDone(keep ? text.trim() : null);
  };
  return (
    <input
      autoFocus
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
      className="nodrag nopan min-w-0 flex-1 rounded border border-accent bg-field px-1 text-sm font-semibold outline-none"
    />
  );
}

function BoxView({ id, data, selected }: NodeProps<BoxNode>) {
  const ctx = useBoard();
  const { box } = data;
  const colour = box.colour;
  const name = box.label || 'Box';
  return (
    <div
      data-box={name}
      data-collapsed={box.collapsed ? 'yes' : 'no'}
      className={`group/box h-full w-full rounded-lg border-2 ${selected ? 'border-accent' : 'border-accent/35'} ${box.collapsed ? 'shadow-panel' : ''} ${ctx.flashId === id ? 'ring-4 ring-accent' : ''}`}
      style={{
        background: colour ? `color-mix(in srgb, ${tint(colour)} 70%, transparent)` : 'color-mix(in srgb, var(--color-accent-tint) 30%, transparent)',
        ...(colour ? { borderColor: ink(colour) } : {}),
      }}
    >
      {!ctx.readOnly && !box.collapsed && (
        <NodeResizer
          isVisible={selected}
          minWidth={MIN_BOX.w}
          minHeight={MIN_BOX.h}
          lineClassName="!border-accent"
          handleClassName="!size-2.5 !border-accent !bg-surface"
          onResizeEnd={(_, frame) => ctx.resized(box, frame)}
        />
      )}
      <div className="flex h-[40px] items-center gap-1.5 px-2">
        <button
          type="button"
          aria-label={box.collapsed ? `Expand ${name}` : `Collapse ${name}`}
          aria-expanded={!box.collapsed}
          disabled={ctx.readOnly}
          onClick={(event) => {
            event.stopPropagation();
            ctx.toggleCollapsed(box);
          }}
          className="nodrag nopan flex size-5 shrink-0 items-center justify-center rounded text-xs text-ink-soft hover:bg-accent-tint"
        >
          {box.collapsed ? '▸' : '▾'}
        </button>
        {ctx.renamingId === box.id ? (
          <BoxName initial={box.label} placeholder="Name this box" onDone={(label) => ctx.rename(box, label)} />
        ) : (
          <span
            onPointerDownCapture={(event) => !ctx.readOnly && ctx.titlePressed(event, Boolean(selected))}
            onClick={(event) => !ctx.readOnly && ctx.titleClicked(id, 'box', event)}
            onDoubleClick={(event) => {
              if (ctx.readOnly || event.shiftKey || event.metaKey || event.ctrlKey) return;
              event.stopPropagation();
              ctx.startRenaming(box.id);
            }}
            className="min-w-0 flex-1 truncate text-xs font-semibold tracking-[0.12em] uppercase"
            style={{ color: colour ? ink(colour) : 'var(--color-accent-deep)' }}
          >
            {name}
          </span>
        )}
        {!box.collapsed && (
          <button
            type="button"
            title="Zoom to this box"
            aria-label={`Zoom to ${name}`}
            onClick={(event) => {
              event.stopPropagation();
              ctx.zoomTo(id);
            }}
            className="nodrag nopan flex size-5 shrink-0 items-center justify-center rounded text-ink-soft opacity-0 group-hover/box:opacity-100 hover:bg-accent-tint hover:text-accent-deep"
          >
            <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
              <circle cx="7" cy="7" r="4.5" />
              <path d="M10.5 10.5 14 14M5 7h4M7 5v4" />
            </svg>
          </button>
        )}
        {!ctx.readOnly && (
          <button
            type="button"
            aria-label={`Actions for ${name}`}
            onClick={(event) => {
              event.stopPropagation();
              ctx.boxMenu(box.id, { x: event.clientX, y: event.clientY });
            }}
            className="nodrag nopan flex size-5 shrink-0 items-center justify-center rounded text-ink-soft opacity-0 group-hover/box:opacity-100 focus-visible:opacity-100 hover:bg-accent-tint"
          >
            ⋮
          </button>
        )}
      </div>
    </div>
  );
}

const nodeTypes = { card: CardView, box: BoxView };

/**
 * What was let go on a card (the POC's *Dropped on an Item* menu): *Put inside*
 * it, which makes it the parent of the Item, or *Combine with it…*. Put inside
 * is not offered where it would put the Item inside itself or something it
 * holds, or where it is already inside.
 */
function DropQuestion({
  ask,
  board,
  items,
  children,
  onAnswer,
}: {
  ask: DropAsk;
  board: Board;
  items: ReadonlyMap<string, Item>;
  children: readonly ChildRow[];
  onAnswer: (answer: 'inside' | 'combine' | null) => void;
}) {
  const target = board.cards.find((card) => card.id === ask.targetCardId);
  const parent = target && items.get(target.itemId);
  if (!parent) return null;
  const name = itemLabel(parent);
  const canGoInside = dropAnswers(ask.itemId, parent.id, children).includes('inside');
  return (
    <Floating at={{ x: ask.at.x + 4, y: ask.at.y + 4 }} label="Dropped on an Item" onClose={() => onAnswer(null)}>
      {canGoInside && (
        <button type="button" role="menuitem" onClick={() => onAnswer('inside')} className={entryClass}>
          Put inside {name}
        </button>
      )}
      <button type="button" role="menuitem" onClick={() => onAnswer('combine')} className={entryClass}>
        Combine with {name}…
      </button>
    </Floating>
  );
}

/** A menu drawn at a press, moved back inside the window where it would spill out of it. */
function Floating({ at, label, onClose, children }: { at: { x: number; y: number }; label: string; onClose: () => void; children: ReactNode }) {
  const menu = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState(at);
  useLayoutEffect(() => {
    const el = menu.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPlace({ x: Math.max(8, Math.min(at.x, window.innerWidth - width - 8)), y: Math.max(8, Math.min(at.y, window.innerHeight - height - 8)) });
  }, [at]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <>
      <div className="fixed inset-0 z-floating" onPointerDown={onClose} onContextMenu={(event) => (event.preventDefault(), onClose())} />
      <div ref={menu} role="menu" aria-label={label} className="fixed z-floating min-w-48 rounded-md border border-shade/10 bg-surface p-1 shadow-lg" style={{ left: place.x, top: place.y }}>
        {children}
      </div>
    </>,
    document.body,
  );
}

const entryClass = 'block w-full rounded px-3 py-1.5 text-left text-sm text-ink hover:bg-accent-tint hover:text-accent-deep';

/**
 * A label typed for a link or a free line: kept on Enter, on leaving it, or
 * when its menu closes, if changed; Escape leaves it as it was. Enter and
 * Escape close the menu.
 */
function LabelField({ initial, label, onDone, onEnd }: { initial: string; label: string; onDone: (label: string) => void; onEnd: () => void }) {
  const [text, setText] = useState(initial);
  // What is typed, and what was last sent or found there: each keep sends the text only where it differs.
  const kept = useRef<{ text: string; sent: string; escaped: boolean }>({ text: initial, sent: initial, escaped: false });
  kept.current.text = text;
  const keep = () => {
    const typed = kept.current.text.trim();
    if (kept.current.escaped || typed === kept.current.sent) return;
    kept.current.sent = typed;
    onDone(typed);
  };
  useEffect(() => {
    // Mounted again in development's double run: nothing has been let go.
    kept.current.escaped = false;
    // Closed by a press elsewhere, which takes the field away before it can lose the focus.
    return keep;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <input
      autoFocus
      value={text}
      maxLength={200}
      placeholder="Label (optional)"
      aria-label={label}
      onChange={(event) => setText(event.target.value)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter') keep();
        if (event.key === 'Escape') kept.current.escaped = true;
        if (event.key === 'Enter' || event.key === 'Escape') onEnd();
      }}
      onBlur={keep}
      className="w-full rounded-md border border-shade/10 bg-field px-2 py-1 text-sm outline-none focus:border-accent"
    />
  );
}

/** A label typed and not yet kept is kept before what it labels is removed: leaving the field keeps it, and some browsers' buttons take no focus. */
function keepTyped() {
  if (document.activeElement instanceof HTMLInputElement) document.activeElement.blur();
}

/** A link clicked (the POC's): its kind, its own label, and *Remove link*. */
function LinkMenu({
  at,
  link,
  kinds,
  onKind,
  onLabel,
  onRemove,
  onClose,
}: {
  at: { x: number; y: number };
  link: { id: string; kindId: string; label: string | null } | undefined;
  kinds: readonly LineKind[];
  onKind: (linkId: string, kindId: string) => void;
  onLabel: (linkId: string, label: string) => void;
  onRemove: (linkId: string) => void;
  onClose: () => void;
}) {
  if (!link) return null;
  return (
    <Floating at={{ x: at.x + 6, y: at.y + 6 }} label="Link" onClose={onClose}>
      <div className="w-56 p-1">
        <p className="px-1 pb-1 text-xs font-semibold tracking-[0.12em] text-accent-deep uppercase">Kind</p>
        {kinds.map((one) => (
          <button
            key={one.id}
            type="button"
            role="menuitemradio"
            aria-checked={one.id === link.kindId}
            onClick={() => {
              if (one.id !== link.kindId) onKind(link.id, one.id);
              onClose();
            }}
            className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-accent-tint ${one.id === link.kindId ? 'font-medium text-accent-deep' : 'text-ink'}`}
          >
            <KindSample kind={one} />
            {one.name}
          </button>
        ))}
        <div className="mt-2">
          <LabelField initial={link.label ?? ''} label="Label of this link" onDone={(label) => onLabel(link.id, label)} onEnd={onClose} />
        </div>
        <button type="button" role="menuitem" onClick={() => (keepTyped(), onRemove(link.id))} className="mt-1 w-full rounded px-2 py-1 text-left text-sm text-over-ink hover:bg-accent-tint">
          Remove link
        </button>
      </div>
    </Floating>
  );
}

/** A free line clicked, or just drawn: its label, and *Remove line*. */
function LineMenu({
  at,
  line,
  onLabel,
  onRemove,
  onClose,
}: {
  at: { x: number; y: number };
  line: BoardLine | undefined;
  onLabel: (lineId: string, label: string) => void;
  onRemove: (line: BoardLine) => void;
  onClose: () => void;
}) {
  if (!line) return null;
  return (
    <Floating at={{ x: at.x + 6, y: at.y + 6 }} label="Line" onClose={onClose}>
      <div className="w-56 p-1">
        <LabelField initial={line.label} label="Label this line" onDone={(label) => onLabel(line.id, label)} onEnd={onClose} />
        <button type="button" role="menuitem" onClick={() => (keepTyped(), onRemove(line))} className="mt-1 w-full rounded px-2 py-1 text-left text-sm text-over-ink hover:bg-accent-tint">
          Remove line
        </button>
      </div>
    </Floating>
  );
}

/** Snap to grid, remembered per board on this device. */
function useGrid(dashboardId: string): [boolean, () => void] {
  const key = `cockpit-board-grid:${dashboardId}`;
  const [grid, setGrid] = useState(() => {
    try {
      return localStorage.getItem(key) !== 'off';
    } catch {
      return true;
    }
  });
  const toggle = () =>
    setGrid((was) => {
      try {
        localStorage.setItem(key, was ? 'off' : 'on');
      } catch {
        // A private window: kept for this visit only.
      }
      return !was;
    });
  return [grid, toggle];
}

type Pending = { x: number; y: number; w: number; h: number; parentBoxId: string | null };
/**
 * What was let go over a card: where to ask, the card it is on, the Item let go, its own card on this board
 * (`fromCardId`, null where it has none), and, for a lone row from the Panels, the Panel and parent it was lifted from.
 */
type DropAsk = {
  at: { x: number; y: number };
  targetCardId: string;
  itemId: string;
  fromCardId: string | null;
  lifted: { panelId: string | null; parentId: string | null } | null;
};

function BoardInner({ workspaceId, dashboardId, readOnly }: { workspaceId: string; dashboardId: string; readOnly: boolean }) {
  const { data } = useSnapshot(workspaceId);
  const openItem = useOpenItem();
  const send = useSendCommand();
  const latest = useLatestSnapshot();
  const offerToUndo = useUndo();
  const flow = useReactFlow<FlowNode, LinkEdge>();
  const initialised = useNodesInitialized();
  const { zoom } = useViewport();
  const [tool, setTool] = useState<Tool>('select');
  const [grid, toggleGrid] = useGrid(dashboardId);
  const [full, setFull] = useState(false);
  const [width, setWidth] = useState(1000);
  const [nodes, setNodes] = useState<FlowNode[]>([]);
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());
  const [flashId, setFlashId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [drawing, setDrawing] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  // Links and free lines ("Brainstorming: the whiteboard can't show how Items connect", issue 1831): the kind the next link is drawn as, whether every link names its kind, the link under the pointer, and a link's or line's menu.
  const [kindId, setKindId] = useState<string | null>(null);
  const [showLabels, setShowLabels] = useState(false);
  const [hoveredLink, setHoveredLink] = useState<string | null>(null);
  const [linkMenu, setLinkMenu] = useState<{ linkId: string; at: { x: number; y: number } } | null>(null);
  const [lineMenu, setLineMenu] = useState<{ lineId: string; at: { x: number; y: number } } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [line, setLine] = useState<string | null>(null);
  const [boxMenu, setBoxMenu] = useState<{ boxId: string; at: { x: number; y: number } } | null>(null);
  const [cardMenu, setCardMenu] = useState<{ itemId: string; at: { x: number; y: number }; n: number } | null>(null);
  const [deleting, setDeleting] = useState<BoardBox | null>(null);
  /** The card a card or row being dragged is over, and what was let go over a card, waiting for *Put inside* or *Combine with…*. */
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [dropAsk, setDropAsk] = useState<DropAsk | null>(null);
  /** Counted up to draw every node again from the read, where a card was dragged and nothing is sent. */
  const [redrawn, setRedrawn] = useState(0);
  // Picked on this Dashboard, as its selection is: what goes inside a parent leaves the Panels of it each is on
  // ("Panels: Items put inside a parent stay where they were", issue 1876).
  const addingAsChild = useAddingAsChild(workspaceId, undefined, { panelId: null, heldBy: null, dashboardId });
  const wrapper = useRef<HTMLDivElement>(null);
  const renameLater = useRef<number | null>(null);
  const nodesNow = useRef<FlowNode[]>([]);
  const pressedAt = useRef<{ x: number; y: number; wasSelected: boolean } | null>(null);
  const cameraPlaced = useRef(false);
  const lastClick = useRef<{ id: string; at: number } | null>(null);
  const narrow = width < NARROW;
  // clock-ok: the due pills on cards are read against now, as a row's are.
  const now = Date.now();

  useEffect(() => {
    const el = wrapper.current;
    if (!el || typeof ResizeObserver !== 'function') return;
    const watch = new ResizeObserver((entries) => setWidth(entries[0]?.contentRect.width ?? 1000));
    watch.observe(el);
    return () => watch.disconnect();
  }, []);

  const board = useMemo(() => boardOf(data, dashboardId), [data, dashboardId]);
  const items = useMemo(() => new Map((data?.items ?? []).map((item) => [item.id, item])), [data?.items]);
  const childrenOf = useCallback(
    (itemId: string) => childIdsOf(data?.children ?? [], itemId).flatMap((id) => (items.has(id) ? [items.get(id)!] : [])),
    [data?.children, items],
  );
  const cardOf = useCallback((id: string) => board.cards.find((card) => card.id === id), [board.cards]);
  const kinds = useMemo(() => kindsOrFixed(workspaceId, data?.whiteboards?.lineKinds), [workspaceId, data?.whiteboards?.lineKinds]);
  const kind = kinds.find((one) => one.id === kindId) ?? kinds[0]!;
  const allLinks = data?.whiteboards?.links;
  const boxOf = useCallback((id: string) => board.boxes.find((box) => box.id === id), [board.boxes]);

  const envelope = () => ({ commandId: uuidv7(), issuedAt: new Date().toISOString(), workspaceId });
  const run = (change: CommandArgs, notDone: string) =>
    send(change).catch((failure: unknown) => offerToUndo({ what: `${notDone} ${whyNotDone(failure)}` }));

  // Nodes: boxes first, parents before what they hold, then cards; positions as the read has them.
  useEffect(() => {
    setNodes((was) => {
      const selected = new Set(was.filter((node) => node.selected).map((node) => node.id));
      const boxes = board.boxes.map(
        (box): BoxNode => ({
          id: box.id,
          type: 'box',
          position: { x: box.x, y: box.y },
          ...(box.parentBoxId ? { parentId: box.parentBoxId } : {}),
          width: box.w,
          height: box.collapsed ? BOX_HEAD : box.h,
          hidden: hiddenByCollapse(board.boxes, box.parentBoxId),
          selected: selected.has(box.id),
          data: { box },
        }),
      );
      const cards = board.cards
        .filter((card) => items.has(card.itemId))
        .map(
          (card): CardNode => ({
            id: card.id,
            type: 'card',
            position: { x: card.x, y: card.y },
            ...(card.boxId ? { parentId: card.boxId } : {}),
            hidden: hiddenByCollapse(board.boxes, card.boxId),
            selected: selected.has(card.id),
            data: { itemId: card.itemId },
          }),
        );
      return [...boxes, ...cards];
    });
  }, [board, items, redrawn]);

  // A parent made by Combine from this Dashboard is drawn unfolded to its children the first time its card is here.
  useEffect(() => {
    const now = takeUnfolds(new Set(board.cards.map((card) => card.itemId)));
    if (now.length > 0) setUnfolded((was) => new Set([...was, ...now]));
  }, [board.cards]);

  // ---- Links: every one with both Items drawn here, as a card or inside an unfolded card ----
  const edges = useMemo(
    () =>
      linksOnTheBoard(allLinks ?? [], kinds, board, (itemId) => (unfolded.has(itemId) ? childIdsOf(data?.children ?? [], itemId).filter((id) => items.has(id)) : [])).map(
        (drawn): LinkEdge => ({
          id: drawn.link.id,
          source: drawn.from.cardId,
          target: drawn.to.cardId,
          type: 'link',
          // In the board's units, so an arrowhead is one size whatever the line's stroke.
          ...(drawn.kind.arrow ? { markerEnd: { type: MarkerType.ArrowClosed, color: lineInk(drawn.kind), width: 28, height: 28, markerUnits: 'userSpaceOnUse' } } : {}),
          // A link whose menu is open is drawn as one under the pointer is.
          data: { drawn, hovered: hoveredLink === drawn.link.id || linkMenu?.linkId === drawn.link.id, showLabels },
        }),
      ),
    [allLinks, kinds, board, unfolded, data?.children, items, hoveredLink, linkMenu?.linkId, showLabels],
  );

  // ---- Selection, followed to and from the rows in the Panels pane ----
  const selectedCards = nodes.filter((node) => node.selected && node.type === 'card') as CardNode[];
  const selectedItemIds = selectedCards.map((node) => node.data.itemId).join(',');
  useEffect(() => {
    selectedOnTheBoard(selectedItemIds ? selectedItemIds.split(',') : []);
  }, [selectedItemIds]);
  useEffect(() => () => selectedOnTheBoard([]), []);
  const { picked } = useSelection(dashboardScope(dashboardId));
  useEffect(() => {
    if (picked.size === 0) return;
    const cards = board.cards.filter((card) => picked.has(card.itemId));
    if (cards.length === 0) return;
    const ids = new Set(cards.map((card) => card.id));
    setNodes((was) => was.map((node) => (node.selected === ids.has(node.id) ? node : { ...node, selected: ids.has(node.id) })));
    // Brought into view only where it is off screen.
    const last = flow.getInternalNode(cards[cards.length - 1]!.id);
    const area = wrapper.current?.getBoundingClientRect();
    if (!last || !area) return;
    const { x, y } = last.internals.positionAbsolute;
    const w = last.measured.width ?? CARD_W;
    const h = last.measured.height ?? 60;
    const topLeft = flow.flowToScreenPosition({ x, y });
    const bottomRight = flow.flowToScreenPosition({ x: x + w, y: y + h });
    if (topLeft.x >= area.left && topLeft.y >= area.top && bottomRight.x <= area.right && bottomRight.y <= area.bottom) return;
    void flow.setCenter(x + w / 2, y + h / 2, { zoom: Math.max(zoom, 0.6), duration: 400 });
    // Only a change of what the rows hold moves the board, never the board's own redraws.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked]);

  // ---- The camera ----
  useEffect(() => {
    if (!initialised || cameraPlaced.current || nodes.length === 0) return;
    cameraPlaced.current = true;
    if (readOnly) {
      const tops = nodes.filter((node) => !node.parentId);
      void flow.setViewport({
        x: 16 - Math.min(...tops.map((node) => node.position.x)) * PHONE_ZOOM,
        y: 64 - Math.min(...tops.map((node) => node.position.y)) * PHONE_ZOOM,
        zoom: PHONE_ZOOM,
      });
    } else void flow.fitView({ padding: 0.1, maxZoom: 1 });
  }, [initialised, nodes, readOnly, flow]);
  const fitAll = useCallback(() => void flow.fitView({ duration: 400, padding: 0.1, maxZoom: 1.5 }), [flow]);
  const zoomTo = useCallback((nodeId: string) => void flow.fitView({ nodes: [{ id: nodeId }], duration: 500, padding: 0.12 }), [flow]);
  const flash = useCallback(
    (nodeId: string) => {
      setFlashId(nodeId);
      window.setTimeout(() => setFlashId(null), 1400);
      void flow.fitView({ nodes: [{ id: nodeId }], duration: 450, maxZoom: Math.max(zoom, 1), padding: 0.4 });
    },
    [flow, zoom],
  );

  // A card asked to be shown (Relations' *On whiteboards*): selected, brought into view and flashed.
  const wantedNow = useCardWanted();
  useEffect(() => {
    if (!initialised) return;
    const cardId = cardWanted(dashboardId);
    if (!cardId || !cardOf(cardId)) return;
    setNodes((was) => was.map((node) => ({ ...node, selected: node.id === cardId })));
    window.setTimeout(() => flash(cardId), 50);
  }, [initialised, wantedNow, dashboardId, cardOf, flash]);

  // ---- Changes ----
  const toggleCollapsed = useCallback(
    (box: BoardBox) => run({ name: 'set_box_collapsed', payload: { ...envelope(), boxId: box.id, collapsed: !box.collapsed } }, 'The box was not changed.'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workspaceId],
  );
  const rename = (box: BoardBox, label: string | null) => {
    setRenamingId(null);
    if (label === null || label === box.label) return;
    void run({ name: 'rename_box', payload: { ...envelope(), boxId: box.id, label } }, 'The box was not renamed.');
  };
  const resized = (box: BoardBox, frame: { x: number; y: number; width: number; height: number }) =>
    void run(
      { name: 'resize_box', payload: { ...envelope(), boxId: box.id, x: Math.round(frame.x), y: Math.round(frame.y), w: Math.round(frame.width), h: Math.round(frame.height) } },
      'The box was not resized.',
    );
  const setColour = (box: BoardBox, colour: Swatch | null) =>
    void run({ name: 'set_box_colour', payload: { ...envelope(), boxId: box.id, colour } }, 'The colour was not changed.');
  const deleteBox = (box: BoardBox) => {
    setDeleting(null);
    const answer = send({ name: 'delete_box', payload: { ...envelope(), boxId: box.id } });
    answer.catch(() => {});
    offerToUndo({
      what: `“${box.label || 'Box'}” deleted`,
      unlessRefused: answer,
      undo: () => send({ name: 'restore_box', payload: { ...envelope(), boxId: box.id } }),
    });
  };

  // ---- Links, their kinds, and free lines ----
  /** A dot dragged from a card and let go on another card, or on an Item inside an unfolded one, links their Items. */
  const onConnectEnd = (event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
    const fromCard = state.fromNode ? cardOf(state.fromNode.id) : undefined;
    const pointer = pointerOf(event);
    if (readOnly || !fromCard || !pointer) return;
    const under = typeof document === 'undefined' ? null : document.elementFromPoint(pointer.x, pointer.y);
    // An Item inside the card the drag began from is what that card holds, and no board draws a link to it.
    const insideFrom = under?.closest('.react-flow__node')?.getAttribute('data-id') === fromCard.id;
    const nested = insideFrom ? null : (under?.closest('[data-nested-item]')?.getAttribute('data-nested-item') ?? null);
    const onCard = cardAt(flow.screenToFlowPosition(pointer), new Set([fromCard.id])) ?? (state.toNode ? cardOf(state.toNode.id) : undefined);
    const toItemId = nested ?? onCard?.itemId ?? null;
    if (!toItemId || toItemId === fromCard.itemId) return;
    void run({ name: 'link_items', payload: { ...envelope(), linkId: uuidv7(), fromItemId: fromCard.itemId, toItemId, kindId: kind.id } }, 'The link was not made.');
  };
  const removeLink = (linkId: string) => {
    setLinkMenu(null);
    // Gone from under the pointer, which will not be heard leaving it.
    setHoveredLink(null);
    const answer = send({ name: 'unlink_items', payload: { ...envelope(), linkId } });
    answer.catch(() => {});
    offerToUndo({ what: 'Link removed', unlessRefused: answer, undo: () => send({ name: 'restore_link', payload: { ...envelope(), linkId } }) });
  };
  const addKind = (made: KindFields) => {
    const id = uuidv7();
    setKindId(id);
    void run({ name: 'add_line_kind', payload: { ...envelope(), kindId: id, ...made } }, 'The line kind was not added.');
  };
  const editKind = (was: LineKind, to: KindFields) => void run({ name: 'edit_line_kind', payload: { ...envelope(), kindId: was.id, ...to } }, 'The line kind was not changed.');
  const deleteKind = (gone: LineKind) => {
    if (kindId === gone.id) setKindId(null);
    const answer = send({ name: 'delete_line_kind', payload: { ...envelope(), kindId: gone.id } });
    answer.catch(() => {});
    offerToUndo({
      what: `“${gone.name}” deleted; its links are Related now`,
      unlessRefused: answer,
      undo: () => send({ name: 'restore_line_kind', payload: { ...envelope(), kindId: gone.id } }),
    });
  };
  const removeLine = (line: BoardLine) => {
    setLineMenu(null);
    const answer = send({ name: 'delete_line', payload: { ...envelope(), lineId: line.id } });
    answer.catch(() => {});
    offerToUndo({ what: 'Line removed', unlessRefused: answer, undo: () => send({ name: 'restore_line', payload: { ...envelope(), lineId: line.id } }) });
  };

  // ---- Rename in place: a click on the title of what is selected, or F2 ----
  const titlePressed = (event: React.PointerEvent, wasSelected: boolean) => {
    pressedAt.current = { x: event.clientX, y: event.clientY, wasSelected };
  };
  const stopRenameLater = () => {
    if (renameLater.current) window.clearTimeout(renameLater.current);
    renameLater.current = null;
  };
  /** A box is renamed at once; a card's title waits out a double-click, which opens the Item instead. */
  const titleClicked = (id: string, kind: 'card' | 'box', event: React.MouseEvent) => {
    const press = pressedAt.current;
    pressedAt.current = null;
    stopRenameLater();
    if (!clickRenames(press, { x: event.clientX, y: event.clientY, detail: event.detail, shiftKey: event.shiftKey, metaKey: event.metaKey, ctrlKey: event.ctrlKey, altKey: event.altKey }, readOnly)) return;
    if (kind === 'box') setRenamingId(id);
    else
      renameLater.current = window.setTimeout(() => {
        renameLater.current = null;
        // Still the one selected: a click on another card, or a drag, in the meantime leaves it be.
        if (renameStillWanted(nodesNow.current.filter((node) => node.selected).map((node) => node.id), id)) setRenamingId(id);
      }, DOUBLE_MS + 20);
  };
  const renameCard = (item: Item, title: string | null) => {
    setRenamingId(null);
    if (title === null || title === '' || title === item.title) return;
    void run({ name: 'set_title', payload: { ...envelope(), itemId: item.id, title } }, 'The title was not changed.');
  };

  // ---- Take a card off: the card and nothing else ----
  const takeOff = (card: PlacedCard) => {
    const item = items.get(card.itemId);
    const answer = send({ name: 'take_card_off', payload: { ...envelope(), cardId: card.id } });
    answer.catch(() => {});
    offerToUndo({
      what: `“${item ? itemLabel(item) : 'Item'}” taken off the whiteboard`,
      unlessRefused: answer,
      undo: () => send({ name: 'put_cards_back', payload: { ...envelope(), cardIds: [card.id] } }),
    });
  };

  // ---- Dropped on a card: Put inside it, or Combine with it ----
  /** The card on the board under a point on it, other than `leaving`: the one drawn last where several overlap. */
  const cardAt = (point: { x: number; y: number }, leaving: ReadonlySet<string>): PlacedCard | null => {
    const frames = board.cards.flatMap((card) => {
      const node = items.has(card.itemId) && !hiddenByCollapse(board.boxes, card.boxId) ? flow.getInternalNode(card.id) : undefined;
      if (!node) return [];
      const { x, y } = node.internals.positionAbsolute;
      return [{ id: card.id, x, y, w: node.measured.width ?? CARD_W, h: node.measured.height ?? 60 }];
    });
    const id = cardUnder(frames, point, leaving);
    return id ? (cardOf(id) ?? null) : null;
  };
  const pointerOf = (event: MouseEvent | TouchEvent | React.MouseEvent | React.TouchEvent) => {
    const at = 'changedTouches' in event ? event.changedTouches[0] : event;
    return at ? { x: at.clientX, y: at.clientY } : null;
  };
  /**
   * *Put inside* moves the Item, as *Add as child of…* does ("Panels: Items put inside a parent stay where they were",
   * issue 1876): a card leaves the Panels of this Dashboard it is on, as a selection here does, and a lone row the
   * Panel or parent it was lifted from, as a row dropped onto a row does. Its own card here comes off too, since the
   * parent's unfolded card draws it now, and Undo puts it back once the Item is back where it was.
   */
  const putInside = (ask: DropAsk) => {
    const target = cardOf(ask.targetCardId);
    const parent = target && items.get(target.itemId);
    const child = items.get(ask.itemId);
    if (!parent || !child || !data) return;
    const from = ask.fromCardId ? cardOf(ask.fromCardId) : undefined;
    setUnfolded((was) => new Set([...was, parent.id]));
    addAsChildren(
      {
        workspaceId,
        send,
        latest,
        data,
        where: pickedOnTheBoard(dashboardId, ask.lifted),
        offerToUndo: offeredWithItsCard(
          offerToUndo,
          from
            ? {
                takeOff: () => send({ name: 'take_card_off', payload: { ...envelope(), cardId: from.id } }),
                putBack: () => send({ name: 'put_cards_back', payload: { ...envelope(), cardIds: [from.id] } }),
              }
            : null,
        ),
      },
      [child],
      parent,
    );
  };
  const answerDrop = (answer: 'inside' | 'combine' | null) => {
    const ask = dropAsk;
    setDropAsk(null);
    setDropTargetId(null);
    if (!ask || !answer) return;
    if (answer === 'inside') putInside(ask);
    else {
      const target = cardOf(ask.targetCardId);
      // The card dropped on is the first, so the new parent is drawn where it is.
      if (target) addingAsChild.combine([target.itemId, ask.itemId], null, true);
    }
  };

  /** Where a node now sits on the board itself. */
  const absoluteNow = (node: FlowNode) => flow.getInternalNode(node.id)?.internals.positionAbsolute ?? node.position;

  const onNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => {
    setNodes((was) => applyNodeChanges(changes.filter((change) => change.type !== 'remove'), was));
  }, []);

  /** The card a lone card being dragged is over, which would take it, ringed while it is. */
  const onNodeDrag = (event: MouseEvent | TouchEvent | React.MouseEvent | React.TouchEvent, node: FlowNode, dragged: FlowNode[]) => {
    const pointer = pointerOf(event);
    const over = pointer && node.type === 'card' && dragged.length === 1 ? cardAt(flow.screenToFlowPosition(pointer), new Set([node.id])) : null;
    setDropTargetId(over?.id ?? null);
  };

  /** Let go: each dragged card or box lands in the box under it, or on open space, where it was left. A lone card let go over another asks what to do instead. */
  const onNodeDragStop = (event: MouseEvent | TouchEvent | React.MouseEvent | React.TouchEvent, first: FlowNode, dragged: FlowNode[]) => {
    setDropTargetId(null);
    const pointer = pointerOf(event);
    const over = pointer && first.type === 'card' && dragged.length === 1 ? cardAt(flow.screenToFlowPosition(pointer), new Set([first.id])) : null;
    const held = over && first.type === 'card' ? cardOf(first.id) : undefined;
    if (over && held && pointer) {
      // It goes back to where it was: nothing moves until one of the two is chosen.
      setRedrawn((was) => was + 1);
      setDropAsk({ at: pointer, targetCardId: over.id, itemId: held.itemId, fromCardId: held.id, lifted: null });
      return;
    }
    for (const node of dragged) {
      const at = absoluteNow(node);
      if (node.type === 'card') {
        const card = cardOf(node.id);
        if (!card) continue;
        const into = boxAt(board.boxes, { x: at.x + 12, y: at.y + 12 });
        const place = into ? relativeTo(board.boxes, into, at) : { x: Math.round(at.x), y: Math.round(at.y) };
        if ((into?.id ?? null) === card.boxId && place.x === card.x && place.y === card.y) continue;
        void run({ name: 'move_card', payload: { ...envelope(), cardId: card.id, boxId: into?.id ?? null, ...place } }, 'The card was not moved.');
      } else {
        const box = boxOf(node.id);
        if (!box) continue;
        const into = boxAt(board.boxes, { x: at.x + 12, y: at.y + 12 }, boxesWithin(board.boxes, box.id));
        const place = into ? relativeTo(board.boxes, into, at) : { x: Math.round(at.x), y: Math.round(at.y) };
        if ((into?.id ?? null) === box.parentBoxId && place.x === box.x && place.y === box.y) continue;
        void run({ name: 'move_box', payload: { ...envelope(), boxId: box.id, parentBoxId: into?.id ?? null, ...place } }, 'The box was not moved.');
      }
    }
  };

  /** A double-click opens only when both clicks hit the same card, in time, with no key held. */
  const onNodeClick = (event: React.MouseEvent, node: FlowNode) => {
    setLine(null);
    if (node.type !== 'card') return;
    if (readOnly) {
      openItem(node.data.itemId);
      return;
    }
    if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) {
      lastClick.current = null;
      return;
    }
    const at = performance.now();
    const last = lastClick.current;
    if (last && last.id === node.id && at - last.at < DOUBLE_MS) {
      lastClick.current = null;
      stopRenameLater();
      openItem(node.data.itemId);
      return;
    }
    lastClick.current = { id: node.id, at };
  };

  // ---- Draw box ----
  const local = (clientX: number, clientY: number) => {
    const rect = wrapper.current!.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  };
  const overlayDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const at = local(event.clientX, event.clientY);
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrawing({ x0: at.x, y0: at.y, x1: at.x, y1: at.y });
  };
  const overlayMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drawing) return;
    const at = local(event.clientX, event.clientY);
    setDrawing({ ...drawing, x1: at.x, y1: at.y });
  };
  const overlayUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drawing) return;
    setDrawing(null);
    setTool('select');
    const rect = wrapper.current!.getBoundingClientRect();
    const a = flow.screenToFlowPosition({ x: drawing.x0 + rect.left, y: drawing.y0 + rect.top });
    const b = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const snap = (v: number) => (grid ? Math.round(v / GRID) * GRID : Math.round(v));
    if (tool === 'line') {
      // A press with no drag draws nothing, nor a line under 12 board units long once snapped; a line drawn asks for its label at once, which may be left empty.
      const [x1, y1, x2, y2] = [snap(a.x), snap(a.y), snap(b.x), snap(b.y)];
      if (Math.hypot(event.clientX - rect.left - drawing.x0, event.clientY - rect.top - drawing.y0) < 12 || Math.hypot(x2 - x1, y2 - y1) < 12) return;
      const lineId = uuidv7();
      void run(
        { name: 'draw_line', payload: { ...envelope(), lineId, dashboardId, x1, y1, x2, y2, label: '' } },
        'The line was not drawn.',
      );
      setLineMenu({ lineId, at: { x: event.clientX, y: event.clientY } });
      return;
    }
    const topLeft = { x: snap(Math.min(a.x, b.x)), y: snap(Math.min(a.y, b.y)) };
    const parent = boxAt(board.boxes, topLeft);
    const place = relativeTo(board.boxes, parent, topLeft);
    setPending({ ...place, w: Math.max(MIN_BOX.w, snap(Math.abs(b.x - a.x))), h: Math.max(MIN_BOX.h, snap(Math.abs(b.y - a.y))), parentBoxId: parent?.id ?? null });
  };
  const drawn = (label: string | null) => {
    const was = pending;
    setPending(null);
    if (!was || label === null) return;
    void run(
      { name: 'draw_box', payload: { ...envelope(), boxId: uuidv7(), dashboardId, parentBoxId: was.parentBoxId, label, colour: null, x: was.x, y: was.y, w: was.w, h: was.h } },
      'The box was not drawn.',
    );
  };

  // ---- A row dropped on the board ----
  const onDragOver = (event: React.DragEvent) => {
    if (readOnly || !event.dataTransfer.types.includes(ITEM_BEING_DRAGGED)) return;
    event.preventDefault();
    // What the row allows (`ItemRow`): placing takes nothing from where it was, but any other effect refuses the drop.
    event.dataTransfer.dropEffect = 'move';
    // A row over a card rings it: letting go there asks what to do with the two.
    const under = cardUnderPointer(event.target);
    if (under !== dropTargetId) setDropTargetId(under);
  };
  const cardUnderPointer = (target: EventTarget | null): string | null =>
    (target as Element | null)?.closest?.('.react-flow__node-card')?.getAttribute('data-id') ?? null;
  const onDrop = (event: React.DragEvent) => {
    if (readOnly || !data || !event.dataTransfer.types.includes(ITEM_BEING_DRAGGED)) return;
    event.preventDefault();
    const itemId = event.dataTransfer.getData(ITEM_BEING_DRAGGED);
    if (!itemId) return;
    const carried = selectionCarried();
    const ids = carried?.ids.includes(itemId) ? [...carried.ids] : [itemId];
    const point = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    // One row let go on a card is asked about, as a card dragged there is; several are placed as cards.
    const onCard = cardUnderPointer(event.target);
    setDropTargetId(null);
    if (ids.length === 1 && onCard) {
      const target = cardOf(onCard);
      if (target?.itemId === itemId) flash(target.id);
      else if (target) {
        // A row whose Item has a card of its own here: that card comes off if it is put inside.
        const own = board.cards.find((card) => card.itemId === itemId);
        // Read now: the drag forgets where it was lifted from once it ends. A selection of one leaves as a selection does.
        const lifted = carried?.ids.includes(itemId) ? null : { panelId: panelLiftedFrom(itemId), parentId: parentLiftedFrom(itemId) };
        setDropAsk({ at: { x: event.clientX, y: event.clientY }, targetCardId: target.id, itemId, fromCardId: own?.id ?? null, lifted });
      }
      return;
    }
    const refused: string[] = [];
    ids.forEach((id, n) => {
      const already = board.cards.find((card) => card.itemId === id);
      if (already) {
        flash(already.id);
        return;
      }
      const why = whyNotPlaceable(data, id);
      if (why) {
        refused.push(why);
        return;
      }
      const at = { x: point.x - CARD_W / 2, y: point.y - 20 + n * 80 };
      const into = boxAt(board.boxes, point);
      void send({
        name: 'place_card',
        payload: { ...envelope(), cardId: uuidv7(), dashboardId, itemId: id, boxId: into?.id ?? null, ...relativeTo(board.boxes, into, at) },
      }).catch((failure: unknown) => setLine(whyNotDone(failure)));
    });
    setLine(refused.length === 0 ? null : refused.length === 1 ? refused[0]! : `${refused.length} Items are in the Inbox. File them on a Panel or put them inside an Item first.`);
  };

  // ---- Keys ----
  useEffect(() => {
    nodesNow.current = nodes;
  }, [nodes]);
  const selectedNodes = nodes.filter((node) => node.selected);
  const lone = selectedNodes.length === 1 ? selectedNodes[0]! : null;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === 'F2') {
        // On the board, with one card or box selected and nothing else asking for a key.
        const typing = event.target instanceof HTMLElement && (/INPUT|TEXTAREA/.test(event.target.tagName) || event.target.isContentEditable);
        const windowOpen = document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]') !== null;
        const focusOnBoard = wrapper.current?.contains(document.activeElement) ?? false;
        if (!lone || !f2Renames({ readOnly, selected: selectedNodes.length, typing, windowOpen, focusOnBoard })) return;
        event.preventDefault();
        stopRenameLater();
        setRenamingId(lone.id);
        return;
      }
      if (event.key !== 'Escape') return;
      if (full) setFull(false);
      setTool('select');
      setDrawing(null);
      setLinkMenu(null);
      setLineMenu(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [full, lone?.id, selectedNodes.length, readOnly]);
  useEffect(() => stopRenameLater, []);
  // A name kept or let go hands the focus back to what was renamed, so F2 renames it again.
  const wasRenaming = useRef<string | null>(null);
  useEffect(() => {
    const was = wasRenaming.current;
    wasRenaming.current = renamingId;
    if (renamingId !== null || was === null) return;
    const node = [...(wrapper.current?.querySelectorAll<HTMLElement>('.react-flow__node') ?? [])].find((one) => one.dataset.id === was);
    node?.focus({ preventScroll: true });
  }, [renamingId]);

  const ctx: Ctx = {
    readOnly,
    items,
    childrenOf,
    sourceNames: data?.sourceNames,
    now,
    unfolded,
    flashId,
    dropTargetId,
    renamingId,
    titlePressed,
    titleClicked,
    renameCard,
    toggleUnfolded: (itemId) =>
      setUnfolded((was) => {
        const next = new Set(was);
        if (!next.delete(itemId)) next.add(itemId);
        return next;
      }),
    cardMenu: (cardId, at) => {
      const card = cardOf(cardId);
      if (card) setCardMenu((was) => ({ itemId: card.itemId, at, n: (was?.n ?? 0) + 1 }));
    },
    boxMenu: (boxId, at) => setBoxMenu({ boxId, at }),
    openItem,
    toggleCollapsed,
    zoomTo,
    startRenaming: setRenamingId,
    rename,
    resized,
  };
  const menuBox = boxMenu ? boxOf(boxMenu.boxId) : undefined;
  const pendingAt = pending ? originOf(board.boxes, pending.parentBoxId) : null;
  const empty = board.boxes.length === 0 && board.cards.length === 0;

  return (
    <BoardContext.Provider value={ctx}>
      <style>{`
        [data-whiteboard] .board-dot { width: 10px; height: 10px; background: var(--color-surface); border: 2px solid var(--color-accent); opacity: 0; transition: opacity .12s; }
        [data-whiteboard] .react-flow__node-card:hover .board-dot, [data-whiteboard] .react-flow__node-card.selected .board-dot, [data-whiteboard] .react-flow__node-card .board-dot.connectingfrom { opacity: 1; }
        [data-whiteboard] .board-dot:hover { background: var(--color-accent); }
        [data-whiteboard] .board-dot.board-dot-unseen { visibility: hidden; }
      `}</style>
      <div
        ref={wrapper}
        data-whiteboard={dashboardId}
        onDragOver={onDragOver}
        onDragLeave={(event) => !event.currentTarget.contains(event.relatedTarget as globalThis.Node | null) && setDropTargetId(null)}
        onDrop={onDrop}
        className={`${full ? 'fixed inset-0 z-floating' : 'relative h-full w-full'} overflow-hidden rounded-md border border-shade/10 bg-surface`}
      >
        <ReactFlow<FlowNode, LinkEdge>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onConnectEnd={onConnectEnd}
          connectionMode={ConnectionMode.Loose}
          connectOnClick={false}
          connectionLineStyle={{ stroke: lineInk(kind), strokeWidth: 2, ...(DASHES[kind.style] ? { strokeDasharray: DASHES[kind.style] } : {}) }}
          onEdgeClick={(event, edge) => {
            if (readOnly) return;
            setLinkMenu({ linkId: edge.id, at: { x: event.clientX, y: event.clientY } });
          }}
          onEdgeMouseEnter={(_, edge) => setHoveredLink(edge.id)}
          onEdgeMouseLeave={() => setHoveredLink(null)}
          onNodeDragStart={stopRenameLater}
          onNodeDrag={onNodeDrag}
          onNodeDragStop={onNodeDragStop}
          onNodeClick={onNodeClick}
          onNodeContextMenu={(event, node) => {
            if (readOnly) return;
            event.preventDefault();
            if (node.type === 'card') ctx.cardMenu(node.id, { x: event.clientX, y: event.clientY });
            else setBoxMenu({ boxId: node.id, at: { x: event.clientX, y: event.clientY } });
          }}
          onPaneClick={() => setLine(null)}
          minZoom={0.1}
          maxZoom={2.5}
          zoomOnDoubleClick={false}
          elevateNodesOnSelect={false}
          snapToGrid={grid}
          snapGrid={[GRID, GRID]}
          nodesDraggable={!readOnly}
          nodesConnectable={!readOnly}
          elementsSelectable={!readOnly}
          panOnDrag={[0, 1]}
          panOnScroll
          zoomActivationKeyCode={['Meta', 'Control']}
          selectionKeyCode={readOnly ? null : 'Shift'}
          selectionMode={SelectionMode.Partial}
          multiSelectionKeyCode={['Shift', 'Meta', 'Control']}
          deleteKeyCode={null}
          proOptions={{ hideAttribution: true }}
        >
          {grid && <Background variant={BackgroundVariant.Dots} gap={GRID} size={1.4} color="var(--color-shade)" style={{ opacity: 0.25 }} />}
          <ViewportPortal>
            <FreeLines lines={board.lines} readOnly={readOnly} onPress={(one, at) => setLineMenu({ lineId: one.id, at })} />
            {pending && pendingAt && (
              // A box being drawn, named in its header before it is made.
              <div
                className="absolute rounded-lg border-2 border-dashed border-accent bg-accent-tint/30 p-2"
                style={{ left: pendingAt.x + pending.x, top: pendingAt.y + pending.y, width: pending.w, height: pending.h, pointerEvents: 'all' }}
              >
                <div className="flex">
                  <BoxName initial="" placeholder="Name the new box" onDone={drawn} />
                </div>
              </div>
            )}
          </ViewportPortal>
        </ReactFlow>

        {!readOnly && tool !== 'select' && (
          <div
            className="absolute inset-0 z-10 cursor-crosshair"
            {...(tool === 'box' ? { 'data-drawing-box': '' } : { 'data-drawing-line': '' })}
            onPointerDown={overlayDown}
            onPointerMove={overlayMove}
            onPointerUp={overlayUp}
          >
            {drawing && tool === 'line' && (
              <svg className="pointer-events-none absolute inset-0 h-full w-full">
                <LineBeingDrawn {...drawing} />
              </svg>
            )}
            {drawing && tool === 'box' && (
              <svg className="pointer-events-none absolute inset-0 h-full w-full">
                <rect
                  x={Math.min(drawing.x0, drawing.x1)}
                  y={Math.min(drawing.y0, drawing.y1)}
                  width={Math.abs(drawing.x1 - drawing.x0)}
                  height={Math.abs(drawing.y1 - drawing.y0)}
                  rx={10}
                  fill="color-mix(in srgb, var(--color-accent) 8%, transparent)"
                  stroke="var(--color-accent)"
                  strokeWidth={2}
                />
              </svg>
            )}
          </div>
        )}

        <BoardToolbar
          tool={tool}
          onTool={setTool}
          kindPicker={<KindPicker kinds={kinds} kind={kind} compact={narrow} onPick={setKindId} onAdd={addKind} onEdit={editKind} onDelete={deleteKind} />}
          showLabels={showLabels}
          onShowLabels={() => setShowLabels((was) => !was)}
          grid={grid}
          onGrid={toggleGrid}
          zoom={zoom}
          onZoomIn={() => void flow.zoomIn({ duration: 200 })}
          onZoomOut={() => void flow.zoomOut({ duration: 200 })}
          onFit={fitAll}
          full={full}
          onFull={() => setFull((was) => !was)}
          narrow={narrow}
          readOnly={readOnly}
        />

        {line && (
          <p role="status" className="absolute bottom-3 left-1/2 z-20 max-w-[90%] -translate-x-1/2 rounded bg-toast px-3 py-1.5 text-center text-xs text-white">
            {line}
          </p>
        )}
        {empty && !pending && (
          <p className="pointer-events-none absolute inset-x-4 top-1/2 text-center text-sm text-ink-faint">
            {readOnly ? 'Nothing on this whiteboard yet.' : 'Drag a row here to place it as a card, or draw a box.'}
          </p>
        )}
      </div>

      {/* A card's menu is its row's own: drawn by its row kept out of sight, opened where the card was pressed. */}
      {cardMenu &&
        items.has(cardMenu.itemId) &&
        createPortal(
          <div
            key={cardMenu.n}
            aria-hidden="true"
            className="pointer-events-none fixed w-[320px] opacity-0"
            style={{ left: 0, top: 0 }}
            ref={(el) => {
              if (!el || el.dataset.opened) return;
              const open = (tries: number) => {
                const row = el.querySelector('li');
                if (!row) {
                  if (tries < 40) window.setTimeout(() => open(tries + 1), 25);
                  return;
                }
                el.dataset.opened = '1';
                row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: cardMenu.at.x, clientY: cardMenu.at.y, button: 2 }));
              };
              open(0);
            }}
          >
            <ItemList
              workspaceId={workspaceId}
              items={[items.get(cardMenu.itemId)!]}
              openDashboardId={dashboardId}
              panelId={null}
              gathered
              emptyMessage=""
              onTakeOffTheWhiteboard={() => {
                const card = board.cards.find((one) => one.itemId === cardMenu.itemId);
                if (card) takeOff(card);
              }}
            />
          </div>,
          document.body,
        )}

      {boxMenu && menuBox && (
        <Floating at={boxMenu.at} label={`Actions for ${menuBox.label || 'Box'}`} onClose={() => setBoxMenu(null)}>
          <p className="px-3 pt-1 text-xs text-ink-soft">Colour</p>
          <div className="flex flex-wrap items-center gap-1.5 px-2 py-1.5" role="group" aria-label="Colour">
            {SWATCHES.map((colour) => (
              <button
                key={colour}
                type="button"
                role="menuitemradio"
                aria-checked={menuBox.colour === colour}
                aria-label={colour[0]!.toUpperCase() + colour.slice(1)}
                title={colour[0]!.toUpperCase() + colour.slice(1)}
                onClick={() => {
                  setBoxMenu(null);
                  setColour(menuBox, colour);
                }}
                className={`size-6 rounded-full border-2 ${menuBox.colour === colour ? 'ring-2 ring-accent ring-offset-1' : ''}`}
                style={{ background: tint(colour), borderColor: ink(colour) }}
              />
            ))}
            <button
              type="button"
              role="menuitemradio"
              aria-checked={menuBox.colour === null}
              onClick={() => {
                setBoxMenu(null);
                setColour(menuBox, null);
              }}
              className={`rounded-full border border-shade/20 px-2 text-xs text-ink-soft ${menuBox.colour === null ? 'ring-2 ring-accent ring-offset-1' : ''}`}
            >
              None
            </button>
          </div>
          {(
            [
              [menuBox.collapsed ? 'Expand' : 'Collapse', () => toggleCollapsed(menuBox)],
              ['Zoom to this box', () => zoomTo(menuBox.id)],
              ['Delete box…', () => setDeleting(menuBox), true],
            ] as [string, () => void, boolean?][]
          ).map(([label, act, destructive]) => (
            <button
              key={label}
              type="button"
              role="menuitem"
              onClick={() => {
                setBoxMenu(null);
                act();
              }}
              className={`${entryClass} ${destructive ? 'text-over-ink' : ''}`}
            >
              {label}
            </button>
          ))}
        </Floating>
      )}

      {linkMenu && (
        <LinkMenu
          at={linkMenu.at}
          link={(allLinks ?? []).find((one) => one.id === linkMenu.linkId)}
          kinds={kinds}
          onKind={(linkId, to) => void run({ name: 'set_link_kind', payload: { ...envelope(), linkId, kindId: to } }, 'The link was not changed.')}
          onLabel={(linkId, label) => void run({ name: 'set_link_label', payload: { ...envelope(), linkId, label } }, 'The label was not changed.')}
          onRemove={removeLink}
          onClose={() => setLinkMenu(null)}
        />
      )}
      {lineMenu && (
        <LineMenu
          at={lineMenu.at}
          line={board.lines.find((one) => one.id === lineMenu.lineId)}
          onLabel={(lineId, label) => void run({ name: 'set_line_label', payload: { ...envelope(), lineId, label } }, 'The label was not changed.')}
          onRemove={removeLine}
          onClose={() => setLineMenu(null)}
        />
      )}
      {dropAsk && <DropQuestion ask={dropAsk} board={board} items={items} children={data?.children ?? []} onAnswer={answerDrop} />}
      {addingAsChild.dialog}

      <DeleteQuestion
        open={deleting !== null}
        question={`Delete box “${deleting?.label || 'Box'}”? The boxes and cards in it come off the whiteboard; their Items stay where they are.`}
        confirmText="Delete box"
        confirmLabel="Delete box"
        onCancel={() => setDeleting(null)}
        onConfirm={() => deleting && deleteBox(deleting)}
      />
    </BoardContext.Provider>
  );
}

export default function Whiteboard(props: { workspaceId: string; dashboardId: string; readOnly: boolean }) {
  return (
    <ReactFlowProvider>
      <BoardInner {...props} />
    </ReactFlowProvider>
  );
}
