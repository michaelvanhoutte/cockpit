import { useEffect, useState } from 'react';
import type { Item, ItemType } from '@cockpit/shared';
import { useCapture } from '../capture';
import { typesOffered, typeToOffer } from '../itemTypes';

/**
 * Fast capture (§5.4) as the Inbox's first row: one line, a type beside it and
 * a button ("Show one Inbox per workspace, with capture at the top of it",
 * issue 89). Writing something down and seeing where it landed are the same
 * place.
 *
 * **The narrow front door, deliberately.** The Capture page is where the same
 * capture is asked in full - a note of several lines, the types as chips, the
 * workspace as a row (pages/CapturePage.tsx) - and this row has to survive a
 * 280px column, which chips and a paragraph box do not. What they must not
 * differ about is what capturing *does*, which is why both run `useCapture`.
 *
 * **It asks what kind of thing this is** ("Capture a thought or an action, and
 * see which it is", issue 155). The types you already have are offered, the
 * ones you used last first, and *No type* is one of the answers.
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
  types: readonly ItemType[];
  items: readonly Item[];
}) {
  const [message, setMessage] = useState('');
  /** The type chosen, by id, or the empty string for *No type*. */
  const [typeId, setTypeId] = useState('');
  /** What the server said about the capture, where it said anything. */
  const [refused, setRefused] = useState<string | null>(null);
  const { ask, busy } = useCapture();

  const offered = typesOffered(types, items);
  const opensOn = typeToOffer(types, items);

  /**
   * What is actually chosen, as against what was chosen: a type deleted in
   * another tab is gone from the list a moment later, and both the dropdown and
   * the capture fall back to *No type* rather than one showing a choice that is
   * not there and the other sending an id the server would refuse.
   */
  const chosen = offered.some((type) => type.id === typeId) ? typeId : '';

  // The type used last, filled in for you. It follows the snapshot rather than
  // being set once, so capturing something else and coming back offers what you
  // just used - and *No type* stays chosen, because choosing it is a thing
  // somebody did on purpose.
  useEffect(() => {
    setTypeId((already) => (already === '' && opensOn ? opensOn.id : already));
    // Keyed on which type it is, not on the object: `typeToOffer` derives a
    // fresh one from every snapshot, so keying on the object re-ran this on
    // each background revalidation and undid a choice somebody made on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opensOn?.id]);

  /**
   * **The box is emptied only once the capture has been asked for**, and a
   * refusal on the way is said out loud. Clearing it first threw the note away
   * on a request that never arrived, with nothing on screen to say so.
   */
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = message.trim();
    if (!trimmed) return;

    ask(
      { message: trimmed, typeId: chosen || undefined, workspaceId, decided: true },
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
          push the button out of a 280px column. */}
      <select
        value={chosen}
        onChange={(e) => setTypeId(e.target.value)}
        aria-label="What kind of thing this is"
        className="min-w-0 flex-1 rounded-md border border-black/10 bg-white px-3 py-2 text-sm shadow-[inset_0_1px_2px_rgb(41_43_49/0.06)] outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft/40"
      >
        {/* An answer of its own rather than a blank line: a note you have not
            decided the kind of is a normal thing to capture, and it has to be
            possible to go back to having said nothing. */}
        <option value="">No type</option>
        {offered.map((type) => (
          <option key={type.id} value={type.id}>
            {type.name}
          </option>
        ))}
      </select>
      <button
        type="submit"
        disabled={busy}
        className="milled shrink-0 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-deep disabled:opacity-50"
      >
        Capture
      </button>
      {refused && (
        <p role="alert" className="basis-full text-sm text-over">
          {refused}
        </p>
      )}
    </form>
  );
}
