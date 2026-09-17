import { z } from 'zod';
import { prioritySchema, workspaceNameSchema } from './item.js';

/**
 * Panels and the layouts that arrange them ("Panels on a dashboard, with
 * per-screen-size layouts", issue 33).
 *
 * A Panel is a movable, resizable, titled box on a Dashboard
 * (functional-definition.md, "Container hierarchy"). A Layout is one
 * arrangement of that Dashboard's Panels at one screen size.
 */

/** The grid every Dashboard is drawn on (architecture.md §4.4, "packages/shared: schema and command rationale", for why twelve). */
export const GRID_COLUMNS = 12;

/** The tallest and shortest a row may be set to, in pixels (architecture.md §4.4). */
export const MIN_ROW_HEIGHT = 160;
export const MAX_ROW_HEIGHT = 720;

/** The most Panels the gestures will put across one row (architecture.md §4.4). */
export const MOST_ACROSS = 4;

/** The share a Panel gets when nothing has said otherwise — an equal one (architecture.md §4.4). */
export const DEFAULT_CELL_SPAN = 12;

/** A Panel's title obeys exactly the rules a Workspace's and a Dashboard's name does (`workspaceNameSchema`). */
export const panelNameSchema = workspaceNameSchema;

/**
 * What a Panel is made of: the Items filed into it, the text written in it
 * ("Put a panel of text on a dashboard, and write in it", issue 250), or the
 * Items a rule gathers onto it ("Add a Filter panel that shows every filed item
 * due in a window", issue 463). Decided when the Panel is made and never after.
 */
export const PANEL_KINDS = ['items', 'text', 'filter'] as const;
export const panelKindSchema = z.enum(PANEL_KINDS);
export type PanelKind = z.infer<typeof panelKindSchema>;

/**
 * The two kinds the store's own `kind` column has ever held, and the only two
 * it may hold.
 *
 * **A Filter is not one of them, and that is the whole shape of issue 463's
 * store change.** Widening the column's CHECK would mean rebuilding `panels`,
 * which filings, placements and an Item's proposed Panel all point at under
 * RESTRICT — the wall "Take the width and the name off a layout, now that its
 * size carries them" (issue 264) hit on `layouts`. So a Filter is a Panel whose
 * `filter_conditions` column is set, its stored `kind` stays `items`, and the
 * read is where the wire's kind becomes `filter`.
 *
 * It is also what makes rolling the release back survivable: an older release
 * reads a Filter as an empty Panel of items rather than as a kind it has never
 * heard of.
 */
export const STORED_PANEL_KINDS = ['items', 'text'] as const;
export const storedPanelKindSchema = z.enum(STORED_PANEL_KINDS);
export type StoredPanelKind = z.infer<typeof storedPanelKindSchema>;

/**
 * Whether a Panel takes Items filed onto it — a Panel of items alone. Nothing
 * is filed onto a Panel of text (issue 250) and nothing onto a Filter, which
 * gathers what is already filed elsewhere (issue 463).
 */
export function panelTakesItems(panel: { kind: PanelKind }): boolean {
  return panel.kind === 'items';
}

/**
 * Whether a Panel holds the text written in it (issue 250).
 *
 * Its own function beside `panelTakesItems`, for that one's own reason: the
 * three questions used to be two answers to one comparison, and adding the
 * Filter moved what `panelTakesItems` means out from under
 * `refuseUnlessPanelOfText`, which had been asking it. A named question cannot
 * drift that way.
 */
export function panelHoldsText(panel: { kind: PanelKind }): boolean {
  return panel.kind === 'text';
}

/**
 * Whether a Panel gathers what is filed elsewhere rather than holding what is
 * filed onto it — a Filter ("Add a Filter panel that shows every filed item due
 * in a window", issue 463). The third of the three, for the reason above.
 */
export function panelGathers(panel: { kind: PanelKind }): boolean {
  return panel.kind === 'filter';
}

/**
 * How a Panel of text's words are drawn: as the characters that were typed, or
 * as what they mean ("Format what a panel says, without making every
 * dashboard pay for an editor", issue 251); architecture.md §4.4 — not a
 * conversion either way, and `'plain'` is the default for performance.
 */
export const PANEL_FORMATS = ['plain', 'rich'] as const;
export const panelFormatSchema = z.enum(PANEL_FORMATS);
export type PanelFormat = z.infer<typeof panelFormatSchema>;

/** The most a Panel of text holds, matching a Description's own cap (architecture.md §4.4). Not trimmed, unlike a Description. */
export const PANEL_TEXT_LIMIT = 60_000;
export const panelTextSchema = z.string().max(PANEL_TEXT_LIMIT);

/**
 * The windows a Due date condition can ask for ("Add a Filter panel that shows
 * every filed item due in a window", issue 463).
 *
 * **Named periods rather than a pair of dates.** A Filter is a standing view —
 * *this week* has to mean the week you are in whenever you look at it, which a
 * stored Monday cannot say. Each is resolved against the viewer's own local
 * calendar at the moment the Panel is drawn, which is also why matching is
 * worked out in the client (`apps/web/src/filters.ts`).
 */
export const DUE_WINDOWS = ['overdue', 'today', 'week', 'month', 'quarter', 'none'] as const;
export const dueWindowSchema = z.enum(DUE_WINDOWS);
export type DueWindow = z.infer<typeof dueWindowSchema>;

/**
 * One condition on a Filter, on its Due date.
 *
 * **`field` is written down though `dueConditionSchema` alone would not need
 * it**, so the Priority and Type conditions below are another member of a
 * union here rather than a reshaping of every stored Filter — and a Panel
 * condition ("Filter a Filter panel by panel, and name the Filters a panel's
 * deletion affects", issue 465) will be a fourth, the same way.
 *
 * `orOverdue` widens the four periods to take in what is already past — ticked
 * by default, because "due today" without it hides exactly the work that most
 * needs looking at. It says nothing on *overdue* or *not set*, which are not
 * periods, and is stored on them all the same so that ticking it, switching
 * window and switching back does not silently lose the answer.
 */
export const dueConditionSchema = z.object({
  field: z.literal('dueDate'),
  window: dueWindowSchema,
  orOverdue: z.boolean().default(true),
});
export type DueCondition = z.infer<typeof dueConditionSchema>;

/**
 * The most values a Priority or Type condition holds at once ("Filter a
 * Filter panel by priority and type", issue 464).
 *
 * Bounded for the reason `CONDITIONS_LIMIT` (`commands.ts`) bounds the whole
 * list: this is written into the same uncapped column. Three is already every
 * Priority there is; a Type condition could in principle ask for more, and
 * this is a generous cap on a workspace's Types rather than a claim about how
 * many anyone would choose.
 */
export const CONDITION_VALUES_LIMIT = 50;

/**
 * One condition on a Filter, on its Priority ("Filter a Filter panel by
 * priority and type", issue 464).
 *
 * **Matches any value it holds, never all of them** — *Priority is High or
 * Normal* is one condition met by either, the same way a Type condition below
 * reads. An Item with no Priority matches no Priority condition, whatever it
 * asks for: absence is not one of the values on offer.
 */
export const priorityConditionSchema = z.object({
  field: z.literal('priority'),
  values: z.array(prioritySchema).max(CONDITION_VALUES_LIMIT),
});
export type PriorityCondition = z.infer<typeof priorityConditionSchema>;

/**
 * One condition on a Filter, on its Type ("Filter a Filter panel by priority
 * and type", issue 464).
 *
 * **Type ids rather than Types**, so a stored condition survives a Type being
 * renamed or recoloured untouched. A value naming a Type since deleted is
 * ignored when the condition is matched or read back
 * (`apps/web/src/filters.ts`) rather than refused on the way in — the same
 * choice `panelFilterFrom` makes for a shape this release cannot read at all,
 * and for the same reason: a Filter stored before a Type was deleted is not a
 * broken Filter.
 */
export const typeConditionSchema = z.object({
  field: z.literal('type'),
  values: z.array(z.string().min(1)).max(CONDITION_VALUES_LIMIT),
});
export type TypeCondition = z.infer<typeof typeConditionSchema>;

/**
 * One row of a Filter's question: a Due date, a Priority or a Type condition
 * today, a Panel condition to come ("Filter a Filter panel by panel, and name
 * the Filters a panel's deletion affects", issue 465).
 */
export const filterConditionSchema = z.discriminatedUnion('field', [
  dueConditionSchema,
  priorityConditionSchema,
  typeConditionSchema,
]);
export type FilterCondition = z.infer<typeof filterConditionSchema>;

/**
 * What a Filter shows: every condition it has, all of which must hold. OR
 * between them is an idea rather than a rule (`docs/ideas.md`).
 *
 * An object rather than a bare array, so a Filter can grow a setting of its own
 * without every stored one having to be re-read as something else.
 */
export const panelFilterSchema = z.object({
  conditions: z.array(filterConditionSchema).default([]),
});
export type PanelFilter = z.infer<typeof panelFilterSchema>;

/** A Filter with nothing chosen yet — what a new one is, and what an unreadable one reads as. */
export const NO_CONDITIONS: PanelFilter = { conditions: [] };

/**
 * What a stored Filter says, from the text the column holds.
 *
 * **Anything it cannot read is no conditions, never a failure.** The column is
 * free-form text written by whichever release stored it, and a Workspace that
 * will not open because one Panel holds a shape this release does not
 * understand is a far worse answer than a Panel saying it has nothing chosen —
 * which is a state the product already draws and already explains.
 *
 * **A duplicate field is dropped, keeping the first, rather than read back
 * whole.** Before `setPanelFilterSchema`'s own refusal ("Filter a Filter panel
 * by priority and type", issue 464) a Filter could be saved with the same
 * field twice — *+ Add a condition* offered a Due date with nothing stopping
 * a second one — and a Panel stored that way before the refusal shipped is
 * real data, not a hypothetical one. Reading it back deduplicated is what
 * keeps the question's rows keyed one per field (`FilterQuestion.tsx`) and
 * keeps a later, unrelated save of that same Panel from being refused for a
 * duplicate the person saving never chose — the same defensive reasoning this
 * function already applies to a shape it cannot read at all.
 */
export function panelFilterFrom(stored: string | null): PanelFilter | null {
  if (stored === null) return null;
  try {
    const read = panelFilterSchema.safeParse(JSON.parse(stored));
    if (!read.success) return NO_CONDITIONS;
    return { conditions: uniqueByField(read.data.conditions) };
  } catch {
    return NO_CONDITIONS;
  }
}

/** The first condition stored for each field, in order — what `panelFilterFrom` reads a Filter back as. */
function uniqueByField(conditions: readonly FilterCondition[]): FilterCondition[] {
  const seen = new Set<FilterCondition['field']>();
  return conditions.filter((condition) => {
    if (seen.has(condition.field)) return false;
    seen.add(condition.field);
    return true;
  });
}

/** What a Filter's conditions are stored as — the one writer, so nothing else has to know the format. */
export function panelFilterAsStored(conditions: readonly FilterCondition[]): string {
  return JSON.stringify({ conditions });
}

/**
 * A Panel, as it is read back. What a Panel *holds* is not here — a filing is
 * its own shape (`filingSchema` below), because an Item can be filed on
 * several Panels at once ("Panels hold the items filed into them, and the
 * Inbox holds the rest", issue 36; architecture.md §4.4).
 */
export const panelSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  dashboardId: z.string(),
  name: z.string(),
  /** Permissive read-back field; `.catch` also covers the field being absent (architecture.md §4.4). */
  kind: panelKindSchema.catch('items'),
  /** Whether that text is drawn as characters or as what they mean. Permissive like `kind`. */
  format: panelFormatSchema.catch('plain'),
  /** The Markdown of a Panel of text. Empty for a Panel of items. */
  body: z.string().default(''),
  /** Whether that text is read rather than written in — a property of the Panel, not of the viewer (architecture.md §4.4). */
  readOnly: z.boolean().default(false),
  /**
   * What a Filter gathers, and null on every other Panel — the field the wire's
   * `kind` of `filter` is derived from (`STORED_PANEL_KINDS` above). Permissive
   * like `kind`: a copy kept by a browser from before this existed reads as a
   * Panel that is not a Filter rather than as no Panel at all.
   */
  filter: panelFilterSchema.nullable().catch(null).default(null),
});
export type Panel = z.infer<typeof panelSchema>;

/** One Panel in one row of a layout, and how much of that row it takes — a share, not a width (architecture.md §4.4). */
export const layoutCellSchema = z.object({
  panelId: z.string(),
  span: z.number(),
});
export type LayoutCell = z.infer<typeof layoutCellSchema>;

/** One row of a layout: the Panels across it, in order, and how tall it is (architecture.md §4.4). */
export const layoutRowSchema = z.object({
  height: z.number().nullable().default(null),
  cells: z.array(layoutCellSchema),
});
export type LayoutRow = z.infer<typeof layoutRowSchema>;

/** One arrangement of a Dashboard's Panels, at one Screen size ("Draw a dashboard against the screen sizes its account has", issue 263; "Take the width and the name off a layout, now that its size carries them", issue 264; architecture.md §4.4). */
export const layoutSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  dashboardId: z.string(),
  /** The Screen size this Layout arranges the Dashboard for. */
  screenSizeId: z.string(),
  /** The rows, top to bottom, each holding its Panels left to right. */
  rows: z.array(layoutRowSchema).default([]),
});
export type Layout = z.infer<typeof layoutSchema>;

/** A cell on the way *in*, where the limits are real (architecture.md §4.4). */
export const cellInputSchema = z.object({
  panelId: z.string(),
  span: z.number().int().min(1).max(GRID_COLUMNS),
});
export type CellInput = z.infer<typeof cellInputSchema>;

/** A row on the way in. An empty one is refused (architecture.md §4.4). */
export const rowInputSchema = z.object({
  height: z.number().int().min(MIN_ROW_HEIGHT).max(MAX_ROW_HEIGHT).nullable(),
  cells: z.array(cellInputSchema).min(1),
});
export type RowInput = z.infer<typeof rowInputSchema>;

/**
 * One Item filed on one Panel, and where it sits in that Panel's order
 * (issue 36; architecture.md §4.4). An Item may be filed on as many Panels as
 * you like; the Inbox is the absence of a filing, not a Panel of its own.
 */
export const filingSchema = z.object({
  panelId: z.string(),
  itemId: z.string(),
  position: z.number(),
});
export type Filing = z.infer<typeof filingSchema>;
