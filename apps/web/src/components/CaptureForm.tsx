import { useEffect, useId, useState } from 'react';
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
 * ones you used last first, and a name matching none of them makes a new type -
 * which is the only way one comes into existence, because a type you need once
 * is not worth a trip to a settings page.
 *
 * **A text box with a list attached rather than a menu**, so one control does
 * both jobs: choosing from what is there and naming something that is not. A
 * menu would need a "new type…" entry that swaps itself for a text box, which
 * is two states for one question, and a native list is the one popup that
 * behaves on a phone.
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
  const [typeName, setTypeName] = useState('');
  /** What the server said about the type, where it said anything. */
  const [refused, setRefused] = useState<string | null>(null);
  const { ask, busy } = useCapture();
  const listId = useId();

  const offered = typesOffered(types, items);
  const opensOn = typeToOffer(types, items);

  // The type used last, filled in for you. It follows the snapshot rather than
  // being set once, so capturing something else and coming back offers what you
  // just used - and an empty box stays empty, because clearing it is a thing
  // somebody did on purpose.
  useEffect(() => {
    setTypeName((chosen) => (chosen === '' && opensOn ? opensOn.name : chosen));
    // Keyed on which type it is, not on the object: `typeToOffer` derives a
    // fresh one from every snapshot, so keying on the object re-ran this on
    // each background revalidation and refilled a box somebody had emptied on
    // purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opensOn?.id]);

  /**
   * **The box is emptied only once the capture has been asked for**, and a
   * refusal on the way is said out loud. Clearing it first threw the note away
   * on any failure the type could produce - a name the server will not take,
   * the request never arriving - with nothing on screen to say so.
   */
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = message.trim();
    if (!trimmed) return;

    ask(
      { message: trimmed, typeName, types, workspaceId, decided: true },
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
      <input
        value={typeName}
        onChange={(e) => setTypeName(e.target.value)}
        list={listId}
        placeholder="Type"
        aria-label="What kind of thing this is"
        maxLength={60}
        className="min-w-0 flex-1 rounded-md border border-black/10 bg-white px-3 py-2 text-sm shadow-[inset_0_1px_2px_rgb(41_43_49/0.06)] outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft/40"
      />
      <datalist id={listId}>
        {offered.map((type) => (
          <option key={type.id} value={type.name} />
        ))}
      </datalist>
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
