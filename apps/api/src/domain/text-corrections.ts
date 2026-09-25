import type { Item } from '@cockpit/shared';

/**
 * Pure handlers for the store a title or description proposal reads back
 * ("Learn how you write from the titles you correct", issue 394; architecture
 * §6.1: domain imports nothing from the other layers).
 *
 * One row per Item, upserted rather than appended, unlike `decision-history.ts`
 * beside it - a filing is one act and its entry is never touched again;
 * editing a text is not (`docs/text-learning.md`, "The proposal is frozen at
 * your first edit; your side stays live").
 */

/**
 * How far back a proposal reads its own corrections and what stood - a plain
 * rolling window, unlike the routing prompt's own cap, which keys staleness
 * off a Panel still existing rather than a date: writing style has no
 * panel or project of its own to key it off ("Cap the text-learning prompt to
 * the last 30 days, and drop rules and pinned examples as inputs", issue 451;
 * `docs/text-learning.md`, "What goes into the prompt").
 */
export const TEXT_LEARNING_WINDOW_DAYS = 30;

/** The earliest instant still inside the window, as of `now`. */
export function textLearningWindowCutoff(now: Date): string {
  return new Date(now.getTime() - TEXT_LEARNING_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Whether an ISO timestamp falls on or after `cutoff` - the one comparison
 * both `promptCorrections` (`store.ts`) and `deriveWhatStoodForPrompt` below
 * make of a different field (`recordedAt`, `textsProposedAt`), named once so
 * a later change to what "in the window" means has one place to change
 * rather than two copies to find and keep in sync.
 */
export function withinTextLearningWindow(timestamp: string | null, cutoff: string): boolean {
  return timestamp !== null && timestamp >= cutoff;
}

/** One row of `text_corrections` (schema.ts), as `command-service.ts` writes it. */
export interface TextCorrectionRow {
  itemId: string;
  tenantId: string;
  capturedMessage: string;
  proposedTitle: string;
  proposedDescription: string | null;
  settledTitle: string;
  settledDescription: string | null;
  recordedAt: string;
  updatedAt: string;
}

/** One row as a proposal reads it back. */
export interface TextCorrectionEntry {
  itemId: string;
  capturedMessage: string;
  proposedTitle: string;
  proposedDescription: string | null;
  settledTitle: string;
  settledDescription: string | null;
  recordedAt: string;
}

/**
 * Whether a correction row still shows a real difference from what was
 * proposed - false for a row whose settled half was edited back to exactly
 * Cockpit's own words, which a later edit can leave behind (`command-
 * service.ts`'s `UPDATE` branch rewrites the settled half and never deletes
 * or resets the row). The one definition both `renderOneTextCorrection`
 * (`clean-up-a-note.v8.ts`, which reader-facing text) and the corrected-item
 * set (`store.ts`, which the "what stood" ratio counts by) read, so the two
 * can never disagree about the same row again.
 */
export function correctionStillVisible(entry: TextCorrectionEntry): boolean {
  return entry.proposedTitle !== entry.settledTitle || entry.proposedDescription !== entry.settledDescription;
}

/**
 * The row an edit to a still-proposed text writes, or `null` where there is
 * nothing worth recording.
 *
 * **`null` where nothing about the settled half actually changed.** A
 * resubmission of exactly what was already there - a form saved without
 * being touched, a retried command - teaches nothing and would otherwise
 * upsert a row whose proposed and settled halves read identically, which
 * `renderCorrections` (`clean-up-a-note.v8.ts`) would have nothing to show
 * for.
 *
 * **`null` where *this edit* clears the title to nothing**, checked only
 * against the title this call is actually changing, not against whatever the
 * title happens to read right now. Clearing a title teaches nothing about how
 * this person writes (`docs/text-learning.md`'s own test case for this) - but
 * an Item whose title was cleared earlier still has a real description
 * correction to record later, and gating on `updated.title` alone would keep
 * refusing that forever, since a `set_description` command never changes
 * `title` and so never clears the emptiness this guard is watching for.
 *
 * **`proposedTitle`/`proposedDescription` are read off the Item as it stands
 * right now, whichever edit this is.** Only the row a first edit inserts is
 * actually built from them; a later edit computes the same two fields from
 * values that are themselves already a correction, and `command-service.ts`
 * discards exactly those two fields on conflict - the upsert's `set` touches
 * only the settled half, so whatever this function returns for `proposed*` on
 * a second call never overwrites the first row's frozen ones. The same trick
 * `settledBy` in `items.ts` plays with `??` for `texts_settled_at`, done here
 * at the SQL layer instead because there are two columns to freeze together,
 * not one.
 */
export function textCorrectionFor(
  item: Pick<Item, 'id' | 'tenantId' | 'capturedMessage' | 'title' | 'description'>,
  updated: Pick<Item, 'title' | 'description'>,
  issuedAt: string,
): TextCorrectionRow | null {
  const titleChanged = updated.title !== item.title;
  const descriptionChanged = updated.description !== item.description;
  if (!titleChanged && !descriptionChanged) return null;
  if (titleChanged && updated.title.trim() === '') return null;
  return {
    itemId: item.id,
    tenantId: item.tenantId,
    // Never null in practice: a row is only ever built for an Item whose
    // `texts_proposed_at` is set, which requires a captured note in the first
    // place (`jobs/enrichment.ts` refuses to propose for one with none).
    capturedMessage: item.capturedMessage ?? '',
    proposedTitle: item.title,
    proposedDescription: item.description,
    settledTitle: updated.title,
    settledDescription: updated.description,
    recordedAt: issuedAt,
    updatedAt: issuedAt,
  };
}

/** One Item, as much of it as `deriveWhatStood` needs to see. */
export interface JudgeableItem {
  id: string;
  title: string;
  textsProposedAt: string | null;
  /**
   * Whether this Item has been filed, dismissed or completed - the closest
   * proxy this product has today for "a person has actually looked at this
   * row", since nothing records when an Item is merely read in the Inbox
   * (`items.unseen` names a different, unbuilt feature entirely -
   * auto-routing bypassing review, per `docs/functional-definition.md`
   * §5.1 - and is never set true by anything in this codebase).
   */
  actedOn: boolean;
  /**
   * When this Item's texts were taken over from Cockpit, whether or not that
   * edit left a `text_corrections` row - the one fact `correctedItemIds`
   * alone cannot tell apart from "never edited at all". Clearing a title to
   * nothing settles both texts (`items.ts`, `settledBy`) without recording
   * anything, and a later edit on that same Item can never create the row
   * either (`command-service.ts`) - so a text this genuinely was edited, but
   * left no trace of what changed, must be excluded rather than defaulted
   * into "stood".
   */
  textsSettledAt: string | null;
}

/** What a proposal reads about the texts nobody corrected. */
export interface WhatStood {
  proposedTotal: number;
  correctedTotal: number;
  sample: readonly string[];
}

/**
 * The sample stays a sample, whatever `items` scales to: once the proposals
 * are any good, what stood outnumbers what was corrected by an order of
 * magnitude, and rendering all of it would drown the stronger signal in the
 * weaker one (`docs/text-learning.md`, "What goes into the prompt").
 */
const STOOD_SAMPLE_LIMIT = 10;

/**
 * How many texts stood, how many were corrected, and a bounded sample of the
 * titles that stood - the weaker evidence beside the corrections themselves
 * ("Learn how you write from the titles you correct", issue 394;
 * `docs/text-learning.md`, "The rules").
 *
 * **An Item counts only once it has been proposed to and either acted on or
 * corrected.** One Cockpit never proposed for teaches nothing, and one still
 * sitting untouched in the Inbox has not been judged at all - both are
 * counted in neither direction. A correction counts regardless of `actedOn`:
 * editing a proposed text is itself the act of having looked at it, the same
 * reasoning `actedOn`'s own filed-or-dismissed proxy rests on - without this,
 * an Item corrected while still sitting unfiled would be listed in
 * `renderCorrections` (`clean-up-a-note.v8.ts`, which reads every correction
 * unconditionally) while being excluded from this ratio, reading as two
 * sections that disagree about the same Item.
 *
 * **An Item that was edited but left no row is excluded outright, never
 * defaulted into "stood".** `textsSettledAt` set with no entry in
 * `correctedItemIds` means an edit happened whose outcome this store could
 * not record - a title cleared to nothing, most concretely - and "nobody
 * changed it" would be the opposite of what actually happened.
 */
export function deriveWhatStood(items: readonly JudgeableItem[], correctedItemIds: ReadonlySet<string>): WhatStood {
  const judged = items.filter((item) => {
    if (item.textsProposedAt === null) return false;
    if (correctedItemIds.has(item.id)) return true;
    if (item.textsSettledAt !== null) return false;
    return item.actedOn;
  });
  const stood = judged.filter((item) => !correctedItemIds.has(item.id));
  const sample = [...stood]
    .sort((a, b) => (a.textsProposedAt === b.textsProposedAt ? 0 : a.textsProposedAt! < b.textsProposedAt! ? 1 : -1))
    .slice(0, STOOD_SAMPLE_LIMIT)
    .map((item) => item.title);

  return {
    proposedTotal: judged.length,
    correctedTotal: judged.length - stood.length,
    sample,
  };
}

/**
 * The floor below which "what stood" is not shown to a proposal at all - one
 * or two unchanged texts is a coin flip being reported as a pattern, not
 * evidence, unlike a correction, which is meaningful on its own regardless of
 * how many others exist beside it ("Cap the text-learning prompt to the last
 * 30 days, and drop rules and pinned examples as inputs", issue 451;
 * `docs/text-learning.md`, "What goes into the prompt").
 */
export const MIN_STOOD_FOR_PROMPT = 3;

/**
 * What a proposal itself reads about the texts nobody corrected - `items`
 * narrowed to the last 30 days before `deriveWhatStood` above does its usual
 * count and sample, and `null` wherever fewer than `MIN_STOOD_FOR_PROMPT`
 * texts stood in that window.
 *
 * **`correctedItemIds` must already be windowed the same way `promptCorrections`
 * is** (`store.ts` - built from corrections whose own `recordedAt` is in the
 * window, not every correction the account ever recorded).
 * An item counts as in-window here if *either* its own proposal or one of
 * its corrections is recent - not just the proposal - because a text
 * proposed long ago and corrected today still has to be counted as
 * corrected, not silently dropped from both totals: a version windowing only
 * on `textsProposedAt` let such an item appear under "Corrections" while the
 * ratio directly beneath it read "0 of N proposed texts were corrected",
 * disagreeing with the correction the prompt had just shown.
 *
 * **`deriveWhatStood` itself stays unwindowed and unfloored**; this is a
 * narrower view over the same `items`, not a change to it.
 */
export function deriveWhatStoodForPrompt(
  items: readonly JudgeableItem[],
  correctedItemIds: ReadonlySet<string>,
  cutoff: string,
): WhatStood | null {
  const windowed = items.filter(
    (item) => withinTextLearningWindow(item.textsProposedAt, cutoff) || correctedItemIds.has(item.id),
  );
  const stood = deriveWhatStood(windowed, correctedItemIds);
  const unchangedCount = stood.proposedTotal - stood.correctedTotal;
  return unchangedCount >= MIN_STOOD_FOR_PROMPT ? stood : null;
}
