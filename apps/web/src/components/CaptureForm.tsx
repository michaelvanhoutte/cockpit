import { useEffect, useId, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ACCOUNT_WIDE, uuidv7, type Item, type ItemType } from '@cockpit/shared';
import { CommandRefused } from '../api/client';
import { itemTypesQuery, useCommand, useSendCommand } from '../api/queries';
import { typeNamed, typesOffered, typeToOffer } from '../itemTypes';

/**
 * Fast capture (§5.4): today this posts capture_item directly; the
 * create-only outbox (local write first, flush when connectivity allows)
 * wraps this same command when the PWA capture work lands.
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
  decided = true,
  autoFocus = false,
  onCaptured,
}: {
  workspaceId: string;
  types: readonly ItemType[];
  items: readonly Item[];
  /**
   * Whether `workspaceId` is where what this captures *belongs*, or only where
   * it was captured from ("Capture something before you know which workspace it
   * belongs to", issue 165).
   *
   * True in the Inbox's own row, which is inside a workspace and has therefore
   * already said which. False in the header's capture window, which is not.
   */
  decided?: boolean;
  /** True in the window, where the box is the only thing on screen. */
  autoFocus?: boolean;
  /** Told once the capture has been asked for, so a window can close itself. */
  onCaptured?: () => void;
}) {
  const [title, setTitle] = useState('');
  const [typeName, setTypeName] = useState('');
  /** What the server said about the type, where it said anything. */
  const [refused, setRefused] = useState<string | null>(null);
  /** True while the type is being made, so the button says so like any other. */
  const [makingTheType, setMakingTheType] = useState(false);
  const command = useCommand();
  const send = useSendCommand();
  const queryClient = useQueryClient();
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
   * Captures it, making the type first where the name matches none.
   *
   * **The type is made and then looked up again rather than assumed.** The id
   * generated here is only used if this request is what created the type; where
   * another tab made one of that name first the store keeps its row and ignores
   * this one, so capturing against the id invented here would name something
   * nobody stored and be refused - and the note would be gone. Re-reading the
   * types is what turns that race into two people agreeing on one type.
   *
   * **The box is emptied only once the capture has been asked for**, and a
   * refusal on the way is said out loud. Clearing it first threw the note away
   * on any failure the type could produce - a name the server will not take,
   * the request never arriving - with nothing on screen to say so.
   */
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;

    const wanted = typeName.trim();
    const already = wanted ? typeNamed(types, wanted) : undefined;

    const capture = (typeId: string | undefined) => {
      command.mutate({
        name: 'capture_item',
        payload: {
          commandId: uuidv7(),
          issuedAt: new Date().toISOString(),
          workspaceId,
          itemId: uuidv7(),
          title: trimmed,
          ...(typeId ? { typeId } : {}),
          // Sent only when it is false, so every other front door's command
          // reads exactly as it did before this landed.
          ...(decided ? {} : { workspaceDecided: false }),
        },
      });
      setTitle('');
      onCaptured?.();
    };

    if (!wanted || already) {
      capture(already?.id);
      return;
    }

    setMakingTheType(true);
    void (async () => {
      try {
        await send({
          name: 'create_item_type',
          payload: {
            commandId: uuidv7(),
            issuedAt: new Date().toISOString(),
            // The account, not the workspace this was captured in: a type
            // belongs to the account, and the live-updates handler reads that
            // to know every workspace's types have changed. Sending the
            // workspace here left every other tab's list stale until an
            // unrelated refetch happened to catch it up.
            workspaceId: ACCOUNT_WIDE,
            typeId: uuidv7(),
            name: wanted,
          },
        });
        // Whichever request made it, this is the one type now going by that name.
        const made = typeNamed(
          (await queryClient.fetchQuery(itemTypesQuery)).itemTypes,
          wanted,
        );
        capture(made?.id);
        setRefused(null);
      } catch (error) {
        // The note stays in the box, so it can be captured again once the type
        // is named something the server will take.
        setRefused(
          error instanceof CommandRefused
            ? error.message
            : 'That did not reach the server. Try again.',
        );
      } finally {
        setMakingTheType(false);
      }
    })();
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
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Capture a note or to-do…"
        aria-label="Capture a note or to-do"
        autoFocus={autoFocus}
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
        disabled={command.isPending || makingTheType}
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
