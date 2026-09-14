/**
 * Types for the store a title or description proposal reads pinned examples
 * back from ("Pin an example of how you want a note written", issue 397;
 * architecture.md, "Hono + Zod on Cloudflare Workers": domain imports
 * nothing from the other layers).
 *
 * No branching logic lives here, unlike `text-corrections.ts` beside this
 * file: a pinned example has no "proposed vs settled" split to freeze or
 * revert - it is written, replaced or removed exactly as given, one row at
 * a time.
 */

/** One row of `pinned_text_examples` (schema.ts), as `command-service.ts` writes it. */
export interface PinnedExampleRow {
  id: string;
  tenantId: string;
  note: string;
  title: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One row as a proposal, or the window, reads it back. */
export interface PinnedExampleEntry {
  id: string;
  note: string;
  title: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * The note, title and message a `pin_text_example` or `edit_pinned_example`
 * command carries, normalized the one way both write - shared so the two
 * `command-service.ts` cases can never drift on the empty-string rule.
 *
 * **The empty string is a cleared description, stored as absent** rather
 * than as an empty string nothing else in the product would distinguish -
 * the same convention `applySetDescription` (`domain/items.ts`) follows for
 * an Item's own description.
 */
export function pinnedExampleFieldsFrom(cmd: {
  note: string;
  title: string;
  description: string;
}): { note: string; title: string; description: string | null } {
  return { note: cmd.note, title: cmd.title, description: cmd.description || null };
}
