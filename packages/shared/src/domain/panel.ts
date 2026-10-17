import { z } from 'zod';
import { NAME_MAX_LENGTH, isSingleLine, prioritySchema, workspaceNameSchema } from './item.js';

/**
 * Panels and the layouts that arrange them ("Panels on a dashboard, with
 * per-screen-size layouts", issue 33).
 *
 * A Panel is a movable, resizable, titled box on a Dashboard
 * (functional-definition.md, "Container hierarchy"). A Layout is that
 * Dashboard's one arrangement of its Panels.
 */

/** The grid every Dashboard is drawn on (architecture.md §4.4, "packages/shared: schema and command rationale", for why twelve). */
export const GRID_COLUMNS = 12;

/**
 * Where a phone ends. A window narrower than this is drawn one Panel across,
 * whatever the Dashboard's Layout says, and offers no arranging at all. It is
 * the width the repo's own phone viewport sits under (`playwright.config.ts`).
 */
export const PHONE_WIDTH_BELOW = 480;

/** Whether a window is a phone's: too narrow for a Layout to be drawn or made on it; it is read only for its order. */
export function isPhoneWidth(width: number): boolean {
  return width < PHONE_WIDTH_BELOW;
}

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
 * it**, so the Priority and Panel conditions below are other members of
 * a union here rather than a reshaping of every stored Filter.
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
 * The most values a Priority or Panel condition holds at once ("Filter a
 * Filter panel by priority and type", issue 464).
 *
 * Bounded for the reason `CONDITIONS_LIMIT` (`commands.ts`) bounds the whole
 * list: this is written into the same uncapped column. Three is already every
 * Priority there is; a Panel condition could in principle ask for more, and
 * this is a generous cap rather than a claim about how many anyone would
 * choose.
 */
export const CONDITION_VALUES_LIMIT = 50;

/**
 * One condition on a Filter, on its Priority ("Filter a Filter panel by
 * priority and type", issue 464).
 *
 * **Matches any value it holds, never all of them** — *Priority is High or
 * Normal* is one condition met by either, the same way a Panel condition below
 * reads. An Item with no Priority matches no Priority condition, whatever it
 * asks for: absence is not one of the values on offer.
 */
export const priorityConditionSchema = z.object({
  field: z.literal('priority'),
  values: z.array(prioritySchema).max(CONDITION_VALUES_LIMIT),
  /**
   * Whether the condition leaves its values out rather than asking for them
   * ("Include or exclude a Filter panel condition's values, and filter on To do
   * as well as In progress", issue 908). Absent reads as including, which is
   * what every Filter stored before this meant, so no stored Filter is
   * rewritten.
   */
  exclude: z.boolean().optional(),
});
export type PriorityCondition = z.infer<typeof priorityConditionSchema>;

/**
 * One condition on a Filter, on which Panel an Item is filed on ("Filter a
 * Filter panel by panel, and name the Filters a panel's deletion affects",
 * issue 465). Goals are Panels you file into, so this is what lets a Filter
 * ask "on Q3 goals".
 *
 * **Panel ids, never Panels**, so a stored condition survives a Panel being
 * renamed untouched. A value naming
 * a Panel since deleted is ignored rather than refused, the same choice
 * `panelFilterFrom` makes for a shape it cannot read — and a Panel left
 * with none live matches nothing rather than widening to every Panel, which is
 * the one thing a deleted choice must never silently become.
 *
 * **Only an items Panel is ever offered as a value** (`FilterQuestion.tsx`) —
 * never a Filter, which cannot look at itself or another Filter, and never a
 * Panel of text, which nothing is ever filed onto. Matching does not have to
 * enforce that itself: a Panel's kind is decided when it is made and never
 * after (`panelKindSchema`), so an id once offered stays an items Panel until
 * it is deleted.
 */
export const panelConditionSchema = z.object({
  field: z.literal('panel'),
  values: z.array(z.string().min(1)).max(CONDITION_VALUES_LIMIT),
  /**
   * Whether the condition leaves its values out rather than asking for them
   * ("Include or exclude a Filter panel condition's values, and filter on To do
   * as well as In progress", issue 908). Absent reads as including, which is
   * what every Filter stored before this meant, so no stored Filter is
   * rewritten.
   */
  exclude: z.boolean().optional(),
});
export type PanelCondition = z.infer<typeof panelConditionSchema>;

/**
 * One condition on a Filter, on which Dashboard an Item is filed on ("Include or
 * exclude a Dashboard in a Filter panel's conditions", issue 985): the Panels
 * of a Dashboard as they come and go, where a Panel condition would have to
 * list every one and silently miss a Panel added later.
 *
 * **Dashboard ids, never Dashboards**, for the reason a Panel condition holds
 * Panel ids. A value naming a Dashboard since deleted is ignored, and one left
 * with none live matches nothing under *is* and filters nothing under *is not*,
 * as a Panel condition does.
 *
 * **Not the same question as *Panel is not*.** *Dashboard is not A* hides an
 * Item only when every Panel it is filed on sits on an excluded Dashboard: an
 * Item also filed on a board you still want stays. *Dashboard is A* matches an
 * Item filed on any Panel of A.
 */
export const dashboardConditionSchema = z.object({
  field: z.literal('dashboard'),
  values: z.array(z.string().min(1)).max(CONDITION_VALUES_LIMIT),
  /** As on the other conditions: leave the values out rather than ask for them. */
  exclude: z.boolean().optional(),
});
export type DashboardCondition = z.infer<typeof dashboardConditionSchema>;

/**
 * One condition on a Filter, on whether an Item is To do or In progress ("Mark
 * an item In progress, and see since when", issue 568).
 *
 * **Only the two open statuses are on offer**: a Filter only ever sees an Item
 * still open (`itemsThatAreFiled`, `apps/web/src/filing.ts`), which is already
 * either To do or In progress.
 */
export const statusConditionSchema = z.object({
  field: z.literal('status'),
  /**
   * Which of the two open statuses it asks for ("Include or exclude a Filter
   * panel condition's values, and filter on To do as well as In progress",
   * issue 908). Done is not a value: a Filter never draws a Done Item, so
   * asking for it could only ever empty the panel. Absent reads as In progress
   * alone (`statusValuesOf`), which is all a Status condition ever meant before.
   */
  values: z.array(z.enum(['to_do', 'in_progress'])).max(2).optional(),
  /** As on the other conditions: leave the values out rather than ask for them. */
  exclude: z.boolean().optional(),
});
export type StatusCondition = z.infer<typeof statusConditionSchema>;

/** The statuses a Status condition holds - In progress alone where it was stored without any, as every one saved before it took values was. */
export function statusValuesOf(condition: StatusCondition): readonly ('to_do' | 'in_progress')[] {
  return condition.values ?? ['in_progress'];
}

/**
 * One condition on a Filter, on whether an Item has an agent running on it
 * ("Gather the Items an agent is running on into a Filter panel", issue 1153):
 * an open run in any state, whichever Agent started it, a deleted Agent
 * included - the rule the Dashboard filter's *Agent running* already keeps.
 *
 * **Holds only its field**: no values and no *is not*, so a later *is not* or
 * run-state choice adds an optional field the way the Panel and Status
 * conditions grew one, with no stored Filter rewritten. **Accepted risk, as for
 * the Dashboard condition (issue 985):** the previous release cannot read a
 * Filter holding this kind, so it draws that Filter with nothing chosen, and a
 * save of *Filter…* from that state overwrites all its conditions.
 */
export const agentConditionSchema = z.object({
  field: z.literal('agent'),
});
export type AgentCondition = z.infer<typeof agentConditionSchema>;

/**
 * One condition of a Filter: a Due date, a Priority, a Panel, a
 * Dashboard, a Status or an Agent running condition.
 */
export const filterConditionSchema = z.discriminatedUnion('field', [
  dueConditionSchema,
  priorityConditionSchema,
  panelConditionSchema,
  dashboardConditionSchema,
  statusConditionSchema,
  agentConditionSchema,
]);
export type FilterCondition = z.infer<typeof filterConditionSchema>;

/**
 * One row of a Filter: conditions an Item meets by meeting any one of them
 * ("Join a Filter's rows with and, and a row's alternatives with or", issue
 * 1075). A field appears at most once in a row, and in any number of rows.
 */
export type FilterRow = FilterCondition[];

/**
 * What a Filter's rows are grouped under ("Group a Filter panel's items by the
 * Dashboard or Panel they are filed on", issue 805): nothing, which is the one
 * flat list a Filter always drew, a heading per Dashboard, or a heading per
 * Panel of items.
 *
 * **`none` is what every stored Filter without a setting reads as**, and what a
 * save carrying none writes: a stale tab saving a Filter without one puts it
 * back to the flat list.
 */
export const FILTER_GROUPINGS = ['none', 'dashboard', 'panel'] as const;
export const filterGroupingSchema = z.enum(FILTER_GROUPINGS);
export type FilterGrouping = z.infer<typeof filterGroupingSchema>;

/**
 * What a Filter shows: its rows, every one of which an Item has to meet, each
 * met by meeting any one of its conditions ("Store every Filter as rows, and
 * save the All / Any choice as rows", issue 1081) - and what its Items are
 * grouped under (`FilterGrouping`).
 *
 * An object rather than a bare array, so a Filter can grow a setting of its own
 * without every stored one having to be re-read as something else.
 *
 * **A `groupBy` nobody wrote reads as `none`, never as an empty Filter**: the
 * catch is on the field, so a value this release cannot read costs the setting
 * alone and leaves the rows intact. **A Filter stored in the flat shape before
 * rows - `conditions` and `match` - reads as no rows**: every one was rewritten
 * by `0071-filter-rows` (changes.ts), so one met here was written by an older
 * release after a rollback, and a repair change carrying that change's
 * statements is what brings it back.
 */
export const panelFilterSchema = z.object({
  rows: z.array(z.array(filterConditionSchema)).default([]),
  groupBy: filterGroupingSchema.catch('none'),
});
export type PanelFilter = z.infer<typeof panelFilterSchema>;

/** A Filter with nothing chosen yet — what a new one is, and what an unreadable one reads as. */
export const NO_CONDITIONS: PanelFilter = { rows: [], groupBy: 'none' };

/**
 * What a stored Filter says, from the text the column holds.
 *
 * **Anything it cannot read is no rows, never a failure.** The column is
 * free-form text written by whichever release stored it, and a Workspace that
 * will not open because one Panel holds a shape this release does not
 * understand is a far worse answer than a Panel saying it has nothing chosen —
 * which is a state the product already draws and already explains.
 *
 * **A field repeated within a row is dropped, keeping the first, and an empty
 * row is dropped.** Neither can be saved (`setPanelFilterSchema`), but a Filter
 * saved with a field twice before that refusal shipped ("Filter a Filter panel
 * by priority and type", issue 464) is real data, carried into rows as it was;
 * reading it back deduplicated keeps a later, unrelated save of that Panel from
 * being refused for a duplicate the person saving never chose.
 */
export function panelFilterFrom(stored: string | null): PanelFilter | null {
  if (stored === null) return null;
  try {
    const read = panelFilterSchema.safeParse(withoutType(JSON.parse(stored)));
    if (!read.success) return NO_CONDITIONS;
    return {
      rows: read.data.rows.map(uniqueByField).filter((row) => row.length > 0),
      groupBy: read.data.groupBy,
    };
  } catch {
    return NO_CONDITIONS;
  }
}

/**
 * A stored Filter without its Type conditions, which no release reads any more
 * ("Stop filtering and sorting Panels by Type", issue 1066). Dropped from every
 * row specifically, so a Filter keeps every other condition rather than failing
 * whole, and a row left empty is then dropped with the rest; anything that is
 * not a Filter's shape is passed on for the schema to refuse as before.
 */
function withoutType(stored: unknown): unknown {
  if (typeof stored !== 'object' || stored === null) return stored;
  const { rows } = stored as { rows?: unknown };
  if (!Array.isArray(rows)) return stored;
  return {
    ...stored,
    rows: rows.map((row) =>
      Array.isArray(row)
        ? row.filter((one) => !(typeof one === 'object' && one !== null && (one as { field?: unknown }).field === 'type'))
        : row,
    ),
  };
}

/** The first condition stored for each field in a row, in order — what `panelFilterFrom` reads a row back as. */
function uniqueByField(row: readonly FilterCondition[]): FilterRow {
  const seen = new Set<FilterCondition['field']>();
  return row.filter((condition) => {
    if (seen.has(condition.field)) return false;
    seen.add(condition.field);
    return true;
  });
}

/** What a Filter's rows are stored as — the one writer, so nothing else has to know the format. */
export function panelFilterAsStored(
  rows: readonly (readonly FilterCondition[])[],
  groupBy: FilterGrouping = 'none',
): string {
  return JSON.stringify({ rows, groupBy });
}

/**
 * What a Panel of items can be sorted by ("Sort a panel of items by the fields
 * you choose", issue 526), in the order the Sort question offers them.
 */
export const SORT_FIELDS = ['title', 'priority', 'createdAt', 'dueDate'] as const;
export const sortFieldSchema = z.enum(SORT_FIELDS);
export type SortField = z.infer<typeof sortFieldSchema>;

/**
 * Which way one criterion runs. Ascending is A→Z, Low→High, oldest first,
 * soonest first; an Item with no value goes last
 * either way (`apps/web/src/sorting.ts`).
 */
export const SORT_DIRECTIONS = ['asc', 'desc'] as const;
export const sortDirectionSchema = z.enum(SORT_DIRECTIONS);
export type SortDirection = z.infer<typeof sortDirectionSchema>;

export const sortCriterionSchema = z.object({
  field: sortFieldSchema,
  direction: sortDirectionSchema,
});
export type SortCriterion = z.infer<typeof sortCriterionSchema>;

/**
 * A Panel's sort: one criterion or more, each field once, the first deciding
 * and each next one breaking the ties the one before it left.
 *
 * **Manual is its absence, never an empty list** — null on the Panel and on
 * `set_panel_sort` alike, so there is one way to say it and switching back
 * leaves the order you set exactly as it was.
 */
export const panelSortSchema = z
  .array(sortCriterionSchema)
  .min(1)
  .max(SORT_FIELDS.length)
  .refine((criteria) => new Set(criteria.map((one) => one.field)).size === criteria.length, {
    message: 'a field appears once in a sort',
  });
export type PanelSort = z.infer<typeof panelSortSchema>;

/**
 * What a stored sort says, from the text the column holds — or null, which is
 * Manual.
 *
 * **Anything it cannot read is Manual, never a failure**, for the reason
 * `panelFilterFrom` gives: a Workspace that will not open over one Panel's
 * setting is far worse than a Panel drawn in the order you set. A field this
 * release has never heard of fails the whole sort rather than being dropped,
 * because the criteria left would be ordering by something nobody chose. A Type
 * criterion, which no release sorts by any more, is the one field dropped
 * ("Stop filtering and sorting Panels by Type", issue 1066): a sort that was
 * only Type is Manual.
 */
export function panelSortFrom(stored: string | null): PanelSort | null {
  if (stored === null) return null;
  try {
    const parsed: unknown = JSON.parse(stored);
    const criteria =
      typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { criteria?: unknown }).criteria)
        ? (parsed as { criteria: unknown[] }).criteria.filter(
            (one) => !(typeof one === 'object' && one !== null && (one as { field?: unknown }).field === 'type'),
          )
        : parsed;
    const read = z
      .object({ criteria: panelSortSchema })
      .safeParse(Array.isArray(criteria) ? { criteria } : criteria);
    return read.success ? read.data.criteria : null;
  } catch {
    return null;
  }
}

/**
 * What a sort is stored as — the one writer, and null for Manual. An object
 * rather than the bare list, so a sort can grow a setting of its own without
 * every stored one being re-read as something else.
 */
export function panelSortAsStored(sort: readonly SortCriterion[] | null): string | null {
  return sort === null ? null : JSON.stringify({ criteria: sort });
}

/**
 * How narrow a column of a Panel's rows may be made, by the name the form gives
 * it ("Split a wide Panel's rows into columns, at a minimum width set in its
 * settings", issue 1207). The name is what is stored, the pixels are what it
 * means: tuning a width is then a release, and no stored Panel changes.
 */
export const PANEL_COLUMN_WIDTHS = { narrow: 320, medium: 420, wide: 560 } as const;
export const panelColumnsSchema = z.enum(['narrow', 'medium', 'wide']);
export type PanelColumns = z.infer<typeof panelColumnsSchema>;
/** The gap between two columns, in pixels. */
export const PANEL_COLUMN_GAP = 24;

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
   * Whether a Panel of items is kept out of routing proposals ("Keep a Panel
   * out of proposals with Never propose", issue 848). A copy from before this
   * existed reads as unflagged.
   */
  neverPropose: z.boolean().default(false),
  /**
   * What a Filter gathers, and null on every other Panel — the field the wire's
   * `kind` of `filter` is derived from (`STORED_PANEL_KINDS` above). Permissive
   * like `kind`: a copy kept by a browser from before this existed reads as a
   * Panel that is not a Filter rather than as no Panel at all.
   */
  filter: panelFilterSchema.nullable().catch(null).default(null),
  /**
   * How a Panel of items draws its rows, and null for Manual — the order the
   * filings carry ("Sort a panel of items by the fields you choose", issue
   * 526). Permissive like `filter`: a copy from before this existed, or one it
   * cannot read, is a Panel in the order you set.
   */
  sort: panelSortSchema.nullable().catch(null).default(null),
  /**
   * The narrowest a column of this Panel's rows may be, and null for one list
   * ("Split a wide Panel's rows into columns, at a minimum width set in its
   * settings", issue 1207). Permissive like `sort`: a copy from before this
   * existed, or a width this release has never heard of, reads as one list.
   */
  columns: panelColumnsSchema.nullable().catch(null).default(null),
});
export type Panel = z.infer<typeof panelSchema>;

/** One Panel in one row of a layout, and how much of that row it takes — a share, not a width (architecture.md §4.4). */
export const layoutCellSchema = z.object({
  panelId: z.string(),
  span: z.number(),
});
export type LayoutCell = z.infer<typeof layoutCellSchema>;

/**
 * One row of a layout: the Panels across it, in order, and how tall it is
 * (architecture.md §4.4). **A row carrying a title is a Section** ("Add,
 * rename and delete a titled Section on a Dashboard", issue 896): it holds no
 * Panels and is drawn as a band. A row of Panels carries no title at all, so a
 * copy from before Sections reads exactly as it did.
 */
export const layoutRowSchema = z.object({
  height: z.number().nullable().default(null),
  title: z.string().optional(),
  cells: z.array(layoutCellSchema),
});
export type LayoutRow = z.infer<typeof layoutRowSchema>;

/** Whether a row is a Section: a title and no Panels (`layoutRowSchema`). */
export function rowIsSection<R extends Pick<LayoutRow, 'title'>>(row: R): row is R & { title: string } {
  return typeof row.title === 'string';
}

/** A Section's title obeys the rules a Panel's name does, under its own words, and need not be unique. */
export const sectionTitleSchema = z
  .string()
  .trim()
  .min(1, { message: 'a section needs a title' })
  .max(NAME_MAX_LENGTH, { message: `a section title is at most ${NAME_MAX_LENGTH} characters` })
  .refine(isSingleLine, { message: 'a section title is a single line, without tabs or line breaks' });

/**
 * A Dashboard's one arrangement of its Panels ("Convert every Dashboard to its
 * widest Layout and retire Screen sizes", issue 713; architecture.md,
 * "`packages/shared`: schema and command rationale"). At most one per
 * Dashboard, and none until the Dashboard is first arranged.
 */
export const layoutSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  dashboardId: z.string(),
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

/**
 * A row on the way in: Panels and no title, or a Section's title and nothing
 * else. A row with neither is refused (architecture.md §4.4).
 */
export const rowInputSchema = z
  .object({
    height: z.number().int().min(MIN_ROW_HEIGHT).max(MAX_ROW_HEIGHT).nullable(),
    title: sectionTitleSchema.optional(),
    cells: z.array(cellInputSchema),
  })
  .superRefine((row, ctx) => {
    if (row.title === undefined) {
      if (row.cells.length === 0) {
        ctx.addIssue({ code: 'custom', path: ['cells'], message: 'a row holds at least one panel' });
      }
      return;
    }
    if (row.cells.length > 0) {
      ctx.addIssue({ code: 'custom', path: ['cells'], message: 'a section holds no panels' });
    }
    if (row.height !== null) {
      ctx.addIssue({ code: 'custom', path: ['height'], message: 'a section has no height of its own' });
    }
  });
export type RowInput = z.infer<typeof rowInputSchema>;

/**
 * How a Panel is named wherever it has to be told apart from one of the same
 * name on another Dashboard: "Day to day ▸ Admin & money". The one place the
 * wording lives.
 */
export function panelPlace(dashboardName: string, panelName: string): string {
  return `${dashboardName} ▸ ${panelName}`;
}

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
