import { useEffect, useId, useState } from 'react';
import { uuidv7, type Item, type ItemType } from '@cockpit/shared';
import { useCommand } from '../api/queries';
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
}: {
  workspaceId: string;
  types: readonly ItemType[];
  items: readonly Item[];
}) {
  const [title, setTitle] = useState('');
  const [typeName, setTypeName] = useState('');
  const command = useCommand();
  const listId = useId();

  const offered = typesOffered(types, items);
  const opensOn = typeToOffer(types, items);

  // The type used last, filled in for you. It follows the snapshot rather than
  // being set once, so capturing something else and coming back offers what you
  // just used - and an empty box stays empty, because clearing it is a thing
  // somebody did on purpose.
  useEffect(() => {
    setTypeName((chosen) => (chosen === '' && opensOn ? opensOn.name : chosen));
  }, [opensOn]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;

    const wanted = typeName.trim();
    const already = wanted ? typeNamed(types, wanted) : undefined;
    // A name matching none of the types there are is a new one, made before the
    // capture that names it so the item lands with a type rather than without.
    // Both are idempotent, so a retry of either is harmless.
    const typeId = wanted ? (already?.id ?? uuidv7()) : undefined;
    if (wanted && !already) {
      command.mutate({
        name: 'create_item_type',
        payload: {
          commandId: uuidv7(),
          issuedAt: new Date().toISOString(),
          workspaceId,
          typeId: typeId!,
          name: wanted,
        },
      });
    }

    command.mutate({
      name: 'capture_item',
      payload: {
        commandId: uuidv7(),
        issuedAt: new Date().toISOString(),
        workspaceId,
        itemId: uuidv7(),
        title: trimmed,
        ...(typeId ? { typeId } : {}),
      },
    });
    setTitle('');
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
        className="min-w-0 flex-1 basis-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm shadow-[inset_0_1px_2px_rgb(41_43_49/0.06)] outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft/40"
      />
      <input
        value={typeName}
        onChange={(e) => setTypeName(e.target.value)}
        list={listId}
        placeholder="Type"
        aria-label="What kind of thing this is"
        className="min-w-0 flex-1 rounded-md border border-black/10 bg-white px-3 py-2 text-sm shadow-[inset_0_1px_2px_rgb(41_43_49/0.06)] outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft/40"
      />
      <datalist id={listId}>
        {offered.map((type) => (
          <option key={type.id} value={type.name} />
        ))}
      </datalist>
      <button
        type="submit"
        disabled={command.isPending}
        className="milled shrink-0 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-deep disabled:opacity-50"
      >
        Capture
      </button>
    </form>
  );
}
