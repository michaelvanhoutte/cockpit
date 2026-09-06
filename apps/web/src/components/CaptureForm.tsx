import { useState } from 'react';
import type { Item, ItemType } from '@cockpit/shared';
import { useCapture } from '../capture';
import { NO_TYPES, typesOffered } from '../itemTypes';

/**
 * Fast capture (functional definition, "The Inbox and the triage flow") as the
 * Inbox's first row: one line, a type beside it and a button ("Show one Inbox
 * per workspace, with capture at the top of it", issue 89). Writing something down and seeing where it landed are the same
 * place.
 *
 * **The narrow front door, deliberately.** The Capture page is where the same
 * capture is asked in full - a note of several lines, the types as chips, the
 * workspace as a row (pages/CapturePage.tsx) - and this row has to survive a
 * 280px column, which chips and a paragraph box do not. What they must not
 * differ about is what capturing *does*, which is why both run `useCapture`.
 *
 * **It asks what kind of thing this is** ("Capture a thought or an action, and
 * see which it is", issue 155), and there is no answer of *none*: every Item is
 * some kind of thing, so the dropdown lists the types you already have, the
 * ones you used last first, and opens on the one you used last.
 *
 * **A dropdown, where it was a text box with a list attached.** The box was
 * both jobs in one control - choosing from what is there and naming something
 * that is not - and the second job has left: types are made in the window they
 * are managed in ("Make a type where types are managed, not while capturing",
 * issue 203). A box that still took any text would be taking text it could not
 * honour, so what is left is the choosing, and a native dropdown is the one
 * popup that behaves on a phone.
 */
export function CaptureForm({
  workspaceId,
  types,
  items,
}: {
  /**
   * The workspace this row is inside, which is where what it captures belongs -
   * it is the Inbox's row, so the question has already been answered. Capturing
   * without answering it is the page's ("Capture something before you know
   * which workspace it belongs to", issue 165).
   */
  workspaceId: string;
  /**
   * The account's types, or undefined where this copy of the workspace does not
   * carry them - a snapshot stored before the field existed (InboxPanel.tsx).
   * The difference matters: undefined is *not known yet*, and an empty list is
   * *the account has none*, which is the only one this row says out loud.
   */
  types: readonly ItemType[] | undefined;
  items: readonly Item[];
}) {
  const [message, setMessage] = useState('');
  /**
   * The type picked, by id, or the empty string for *not picked one yet* -
   * which is not an answer, only the absence of one. What that resolves to is
   * `chosen` below.
   */
  const [typeId, setTypeId] = useState('');
  /** What the server said about the capture, where it said anything. */
  const [refused, setRefused] = useState<string | null>(null);
  const { ask, busy } = useCapture();

  const offered = typesOffered(types ?? [], items);
  /** Whether this copy of the workspace carries the account's types at all. */
  const answered = types !== undefined;

  /**
   * What is actually chosen, as against what was picked: one not picked yet and
   * one deleted in another tab both fall back to the type used last, rather
   * than the dropdown showing a choice that is not there and the capture
   * sending an id the server would refuse. Derived rather than filled in, so a
   * background reread of the snapshot cannot undo a pick somebody made on
   * purpose.
   *
   * Undefined only where there is nothing to fall back to - an account with no
   * types, or a copy that does not carry them yet - and this row waits either
   * way, because there is no type to give.
   */
  const chosen = offered.find((type) => type.id === typeId) ?? offered[0];

  /**
   * **The box is emptied only once the capture has been asked for**, and a
   * refusal on the way is said out loud. Clearing it first threw the note away
   * on a request that never arrived, with nothing on screen to say so.
   */
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = message.trim();
    if (!trimmed || !chosen) return;

    ask(
      { message: trimmed, typeId: chosen.id, workspaceId, decided: true },
      {
        asking: () => {
          setMessage('');
          setRefused(null);
        },
        refused: (why) => {
          setMessage(trimmed);
          setRefused(why);
        },
      },
    );
  };

  return (
    <form onSubmit={submit} className="flex flex-wrap gap-2">
      {/* `min-w-0` is what lets the box be narrower than the twenty characters
          an input asks for by default. Without it the box refuses to shrink
          and pushes the button out of the panel instead - which is invisible
          to the page-level sideways-scroll check, because the Inbox column
          scrolls inside itself. Found in the browser at 280px, the narrowest
          the column ever gets ("Show the Inbox beside the dashboards instead
          of as a tab", issue 117). */}
      <input
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="Capture a note or to-do…"
        aria-label="Capture a note or to-do"
        className="min-w-0 flex-1 basis-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm shadow-[inset_0_1px_2px_rgb(41_43_49/0.06)] outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft/40"
      />
      {/* `min-w-0` for the reason the box above it carries: a select is as wide
          as its widest option by default, and a type with a long name would
          push the button out of a 280px column.

          Gone where there are no types, along with the *No type* line that used
          to head it: every Item is some kind of thing, so an empty dropdown
          would be a question with no answers rather than a way to say none. */}
      {chosen && (
        <select
          value={chosen.id}
          onChange={(e) => setTypeId(e.target.value)}
          aria-label="What kind of thing this is"
          className="min-w-0 flex-1 rounded-md border border-black/10 bg-white px-3 py-2 text-sm shadow-[inset_0_1px_2px_rgb(41_43_49/0.06)] outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft/40"
        >
          {offered.map((type) => (
            <option key={type.id} value={type.id}>
              {type.name}
            </option>
          ))}
        </select>
      )}
      <button
        type="submit"
        disabled={busy || !chosen}
        className="milled shrink-0 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-deep disabled:opacity-50"
      >
        Capture
      </button>
      {/* Said where the dropdown was, so the row explains itself rather than
          showing a button that does nothing - and only once this copy carries
          the account's types, because "no types yet" is a claim about the
          account rather than about what has reached this column. */}
      {answered && offered.length === 0 && (
        <p className="basis-full text-sm text-ink-faint">{NO_TYPES}</p>
      )}
      {refused && (
        <p role="alert" className="basis-full text-sm text-over">
          {refused}
        </p>
      )}
    </form>
  );
}
