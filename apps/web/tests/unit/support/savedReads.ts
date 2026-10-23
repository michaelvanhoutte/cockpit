import {
  itemSchema,
  panelSchema,
  rewriteHistoryEntrySchema,
  workspaceSnapshotSchema,
  type Item,
  type Panel,
  type RewriteHistoryEntry,
  type WorkspaceSnapshot,
} from '@cockpit/shared';

/**
 * Reads in the shape this version's schemas parse, for the checks a saved one
 * goes through. Each is put through its schema before `over` is spread on, so
 * a property the schema gains with a default is present here too, while a
 * value `over` makes invalid stays invalid.
 */

export const itemId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export function anItem(n: number, over: Partial<Item> = {}): Item {
  const base = itemSchema.parse({
    id: itemId(n),
    tenantId: 'tenant',
    workspaceId: 'ws-work',
    workspaceDecided: true,
    capturedMessage: null,
    capturedTimeZone: null,
    source: 'internal',
    sourceId: null,
    sourceLink: null,
    sender: null,
    sourceTimestamp: null,
    sourceResolvedAt: null,
    title: `Item ${n}`,
    description: null,
    textsSettledAt: null,
    textsProposedAt: null,
    readings: null,
    proposedPanelId: null,
    proposedPanelReason: null,
    proposedPanelFit: null,
    claudeProposals: null,
    seriesId: null,
    waitingSince: null,
    nextAction: null,
    completedAt: null,
    startedAt: null,
    priority: null,
    prioritySetAt: null,
    dueDate: null,
    dueDateSetAt: null,
    dueDateChosenAt: null,
    unseen: false,
    deletedAt: null,
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-01T09:00:00.000Z',
  });
  return { ...base, ...over };
}

export function aPanel(over: Partial<Panel> = {}): Panel {
  const base = panelSchema.parse({
    id: 'panel-today',
    tenantId: 'tenant',
    dashboardId: 'dashboard-today',
    name: 'Today',
    kind: 'items',
    format: 'plain',
    body: '',
    readOnly: false,
    neverPropose: false,
    filter: null,
    sort: null,
  });
  return { ...base, ...over };
}

export function aWorkspace(items: unknown[] = [anItem(1)], over: Record<string, unknown> = {}): WorkspaceSnapshot {
  const base = workspaceSnapshotSchema.parse({
    workspace: {
      id: 'ws-work',
      tenantId: 'tenant',
      name: 'Work',
      color: '#6f62b5',
      bar: '#6f62b5',
      ground: '#e3e1f2',
      header: '#d2cdea',
    },
    items: [],
    dashboards: [{ id: 'dashboard-today', tenantId: 'tenant', workspaceId: 'ws-work', name: 'Today' }],
    panels: [aPanel()],
    layouts: [],
    filings: [],
    associations: [],
    attachments: [],
    itemFormPresentation: 'centered',
    duplicates: [],
    agentRuns: [],
    sourceNames: { gmail: 'Gmail' },
    generatedAt: '2026-10-01T09:00:00.000Z',
  });
  return { ...base, items, ...over } as WorkspaceSnapshot;
}

export function aHistoryEntry(over: Partial<RewriteHistoryEntry> = {}): RewriteHistoryEntry {
  const base = rewriteHistoryEntrySchema.parse({
    id: 'attempt-1',
    itemId: itemId(1),
    titleBefore: 'call ann re q3 numbers',
    titleAfter: 'Call Ann about the Q3 numbers',
    descriptionBefore: null,
    descriptionAfter: null,
    proposedPanelName: null,
    status: 'rewritten',
    message: null,
    attemptedAt: '2026-10-01T09:00:00.000Z',
    looksAt: 'texts-and-panel',
    suggestedPanelBefore: null,
    suggestedPanelAfter: null,
    prioritySet: null,
    dueDateSet: null,
    workspaceSet: null,
    panelsFiledOn: [],
  });
  return { ...base, ...over };
}

/** An entry as it was saved before an Item's history named the Panels it filed on. */
export function aHistoryEntrySavedBeforePanelsFiledOn(): Omit<RewriteHistoryEntry, 'panelsFiledOn'> {
  const { panelsFiledOn: _gone, ...older } = aHistoryEntry();
  return older;
}

/** Everything but `key`, as an older version saved it. */
export function without<T extends object>(value: T, key: keyof T): Omit<T, typeof key> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}
