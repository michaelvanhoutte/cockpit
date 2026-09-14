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
 * The row an edit to a still-proposed text writes, or `null` where there is
 * nothing worth recording.
 *
 * **`null` where nothing about the settled half actually changed.** A
 * resubmission of exactly what was already there - a form saved without
 * being touched, a retried command - teaches nothing and would otherwise
 * upsert a row whose proposed and settled halves read identically, which
 * `renderCorrections` (`clean-up-a-note.v7.ts`) would have nothing to show
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
 * **An Item counts only once it has been proposed to and acted on.** One
 * Cockpit never proposed for teaches nothing about a correction, and one
 * still sitting untouched in the Inbox has not been judged at all - both are
 * counted in neither direction.
 */
export function deriveWhatStood(items: readonly JudgeableItem[], correctedItemIds: ReadonlySet<string>): WhatStood {
  const judged = items.filter((item) => item.textsProposedAt !== null && item.actedOn);
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
