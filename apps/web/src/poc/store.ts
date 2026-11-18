import { useCallback, useSyncExternalStore } from 'react';

/**
 * POC (throwaway): every bit of state the whiteboard, Combine and Split keep,
 * in the browser's localStorage. Nothing here reaches the server.
 */

const listeners = new Set<() => void>();
const cache = new Map<string, unknown>();

function read<T>(key: string, initial: T): T {
  if (cache.has(key)) return cache.get(key) as T;
  let value = initial;
  try {
    const raw = localStorage.getItem(key);
    if (raw !== null) value = JSON.parse(raw) as T;
  } catch {
    // Nothing kept, or nothing readable: start from the initial value.
  }
  cache.set(key, value);
  return value;
}

export function writePoc<T>(key: string, value: T): void {
  cache.set(key, value);
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // A private window: kept for this tab only.
  }
  for (const listener of listeners) listener();
}

export function readPoc<T>(key: string, initial: T): T {
  return read(key, initial);
}

export function updatePoc<T>(key: string, initial: T, update: (was: T) => T): void {
  writePoc(key, update(read(key, initial)));
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePoc<T>(key: string, initial: T): [T, (update: T | ((was: T) => T)) => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => read(key, initial),
    () => initial,
  );
  const set = useCallback(
    (update: T | ((was: T) => T)) => {
      const next = typeof update === 'function' ? (update as (was: T) => T)(read(key, initial)) : update;
      writePoc(key, next);
    },
    // `initial` is a literal at every call site; the key is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );
  return [value, set];
}

// ---- Keys -----------------------------------------------------------------

export const viewKey = (dashboardId: string) => `poc:view:${dashboardId}`;
export const splitKey = (dashboardId: string) => `poc:split:${dashboardId}`;
export const boardKey = (dashboardId: string) => `poc:board:${dashboardId}`;
export const kindsKey = (workspaceId: string) => `poc:kinds:${workspaceId}`;
export const linksKey = (workspaceId: string) => `poc:links:${workspaceId}`;
export const groupsKey = (workspaceId: string) => `poc:groups:${workspaceId}`;
/** Parent Item id → its children's ids: the one relation the POC keeps itself. */
export const relationsKey = (workspaceId: string) => `poc:relations:${workspaceId}`;
/** A whiteboard asked to select and zoom to one of its nodes once it is drawn. */
export const FOCUS_KEY = 'poc:focus';
export const hiddenKey = (workspaceId: string) => `poc:hidden:${workspaceId}`;

// ---- Shapes ---------------------------------------------------------------

export type DashboardView = 'side' | 'stacked' | 'panels' | 'board';
export const DEFAULT_VIEW: DashboardView = 'panels';

/**
 * `card` is an Item and `panel` a Panel; either is drawn as a card, or, with
 * `asBox`, as a box holding its children. `box` is a named frame that is no
 * Item. A `sketch` lives only here.
 */
export type BoardNode =
  | { id: string; kind: 'card'; itemId: string; x: number; y: number; parentId?: string | undefined; asBox?: boolean; w?: number; h?: number }
  | { id: string; kind: 'panel'; panelId: string; x: number; y: number; parentId?: string | undefined; asBox?: boolean; w?: number; h?: number }
  | { id: string; kind: 'sketch'; title: string; x: number; y: number; parentId?: string | undefined; local?: 'merged' }
  | { id: string; kind: 'box'; name: string; x: number; y: number; w: number; h: number; parentId?: string | undefined };

export type Relations = Record<string, string[]>;

export interface FreeLine {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  label: string;
}

export interface Board {
  nodes: BoardNode[];
  lines: FreeLine[];
}
export const EMPTY_BOARD: Board = { nodes: [], lines: [] };

export type LineStyle = 'solid' | 'dashed' | 'dotted' | 'double';
export interface LineKind {
  id: string;
  name: string;
  style: LineStyle;
  colour: string;
  arrow: boolean;
}
export const LEADS_TO = 'leads-to';
export const DEFAULT_KINDS: LineKind[] = [
  { id: LEADS_TO, name: 'Leads to', style: 'solid', colour: '#3a3f4b', arrow: true },
  { id: 'related', name: 'Related', style: 'solid', colour: '#8b8d94', arrow: false },
];

/**
 * A link is between two *Items* (`item:<id>`) wherever they are drawn, so it
 * shows on every Dashboard's whiteboard holding both. A box or a sketch is
 * board-local (`node:<id>`).
 */
export interface Link {
  id: string;
  from: string;
  to: string;
  kindId: string;
  label?: string | undefined;
}

export interface LocalChild {
  id: string;
  title: string;
  done: boolean;
}

export type Group =
  | {
      id: string;
      kind: 'parent';
      title: string;
      description: string;
      panelId: string | null;
      childIds: string[];
      /** Set when combined under an existing Item. */
      parentItemId?: string | undefined;
    }
  | { id: string; kind: 'merged'; title: string; description: string; panelId: string | null; mergedIds: string[] }
  | { id: string; kind: 'split'; parentItemId: string; children: LocalChild[] };

export const newId = () => Math.random().toString(36).slice(2, 10);
