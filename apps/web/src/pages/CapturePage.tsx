import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ItemType, Workspace } from '@cockpit/shared';
import { itemTypesQuery, snapshotQuery, workspacesQuery } from '../api/queries';
import { browserStore, workspaceToCaptureFrom } from '../lastVisited';
import { howLongAgo, useCapture } from '../capture';
import { typeNamed, typesOffered, typeToOffer } from '../itemTypes';

/**
 * Capture as a screen of its own ("Capture Page", artboards 2a and 2c): the
 * note fills the page, the types are chips under it, and where it goes is one
 * more row of chips that starts on *Any workspace*.
 *
 * **A page rather than the window it was.** Capture is the thing the app is
 * meant to do fastest and the thing you arrive wanting to do, and a dialog over
 * a workspace made it an interruption of whatever was behind it - one line
 * high, in front of a screen it had nothing to do with. Here it has the room to
 * take a note of several lines, to show the types as things you press rather
 * than type, and to say what it just did.
 *
 * **It belongs to no workspace**, which is why it is not under one in the
 * address (router.tsx): what it makes waits in every workspace's Inbox until
 * somebody says where it goes, and the Where row is where they say so early if
 * they already know.
 *
 * What capturing *does* is not decided here - `useCapture` holds that, and the
 * Inbox's own row runs the same thing (components/CaptureForm.tsx).
 */
export function CapturePage() {
  const { data: list } = useQuery(workspacesQuery);
  const workspaces = list?.workspaces ?? [];
  /**
   * The workspace this is captured *from*, which every Item records even while
   * it belongs to none ("Capture something before you know which workspace it
   * belongs to", issue 165). The page has no workspace of its own, so the
   * honest answer is the one you were last in (`lastVisited.ts`).
   */
  const from = workspaceToCaptureFrom(browserStore(), workspaces);

  const { data: types } = useQuery(itemTypesQuery);
  /**
   * The workspace you came from, read for its items alone: which types you have
   * been using is worked out from what you have captured (`itemTypes.ts`), and
   * this page has no snapshot of its own to work it out from. It is the same
   * query key the shell already holds, so it costs no request of its own where
   * you came from a workspace - which is every way of getting here but a typed
   * address.
   */
  const snapshot = useQuery({ ...snapshotQuery(from ?? ''), enabled: Boolean(from) });

  const known = types?.itemTypes ?? [];
  const offered = typesOffered(known, snapshot.data?.items ?? []);
  const opensOn = typeToOffer(known, snapshot.data?.items ?? []);

  const [message, setMessage] = useState('');
  /**
   * The type, by name rather than by id, so that a chip and a name nobody has
   * used yet are one answer to one question - the same string the Inbox's row
   * keeps, and what `useCapture` turns into a type.
   */
  const [typeName, setTypeName] = useState('');
  /** What is in the box beside the chips, which is a name and not yet a type. */
  const [naming, setNaming] = useState('');
  /** Which workspace it belongs to, or null for *Any workspace*. */
  const [where, setWhere] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [justCaptured, setJustCaptured] = useState<Captured[]>([]);
  const form = useRef<HTMLFormElement>(null);
  const { ask, busy } = useCapture();

  /**
   * Which chip is lit: none while a name is being typed beside them, because
   * what is in that box is the answer then and lighting a chip as well would
   * say the question had two.
   */
  const chosen = naming.trim() ? undefined : typeNamed(known, typeName);

  // The type used last, filled in for you, for the reason the Inbox's row does
  // it: the type you want is nearly always the one you just used, and an empty
  // choice stays empty because clearing it is a thing somebody did on purpose.
  useEffect(() => {
    setTypeName((chosen) => (chosen === '' && opensOn ? opensOn.name : chosen));
    // Keyed on which type it is rather than on the object, which a fresh
    // snapshot derives anew every time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opensOn?.id]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = message.trim();
    if (!trimmed || !from) return;
    const wanted = naming.trim() || typeName;

    ask(
      {
        message: trimmed,
        typeName: wanted,
        types: known,
        // The workspace chosen, or the one this was captured from - and the
        // difference between the two is the whole of `decided`.
        workspaceId: where ?? from,
        decided: where !== null,
      },
      {
        asking: () => {
          setMessage('');
          setRefused(null);
        },
        captured: (typeId) => {
          setNaming('');
          if (wanted) setTypeName(wanted);
          setJustCaptured((already) => [
            { at: Date.now(), message: trimmed, typeId, typeName: wanted, workspaceId: where },
            ...already,
          ]);
        },
        refused: (why) => {
          setMessage(trimmed);
          setRefused(why);
        },
      },
    );
  };

  return (
    /* The sheet's own hollow, the same one a panel's list sits in ("Cockpit
       Shell Explorations", artboard 2c): this screen is one thing rather than a
       page of cards, so it is one well. */
    <section className="well flex min-h-full flex-col px-4 pt-[18px] pb-[14px] sm:px-10 sm:pt-[30px] sm:pb-[22px]">
      <div className="flex items-baseline gap-3">
        <h1 className="text-xs font-semibold tracking-[0.11em] text-accent-deep uppercase sm:text-[15px]">
          Capture
        </h1>
        {/* Gone on a phone, where the heading and the box below it already say
            the same thing in the space there is. */}
        <span className="hidden text-[13px] text-ink-faint sm:inline">
          Write it down now, decide where it belongs later.
        </span>
      </div>

      <form
        ref={form}
        onSubmit={submit}
        onKeyDown={(e) => {
          // Captures without leaving the keys the note is being typed on, and
          // from anywhere on the form rather than from the box alone: choosing
          // a chip moves the focus off the box, and a shortcut that stopped
          // working once you had said what kind of thing it is would be a
          // shortcut for nothing.
          //
          // Enter on its own is a new line here, which is what a box of
          // several lines means.
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            form.current?.requestSubmit();
          }
        }}
        className="flex min-h-0 flex-1 flex-col"
      >
        {/* **A box of several lines, and the largest text on the screen.** What
            gets captured is a thought as it was had, which is often two
            sentences and sometimes a paragraph; one line high made every one of
            them scroll sideways past itself while it was being written.

            Resizable at a desk and not on a phone, where there is no room to
            grow into and the handle is one more thing under a thumb. */}
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="What is on your mind?"
          aria-label="What is on your mind?"
          autoFocus
          rows={4}
          className="mt-2.5 w-full resize-none rounded-md border border-black/10 bg-white p-3 text-[17px] leading-[1.5] text-ink shadow-[inset_0_1px_2px_rgb(41_43_49/0.06)] outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft/40 sm:mt-4 sm:min-h-56 sm:resize-y sm:px-5 sm:py-[18px] sm:text-[20px]"
        />

        <Choice label="Type">
          {offered.map((type) => (
            <Chip
              key={type.id}
              name={type.name}
              dot={type.color}
              chosen={chosen?.id === type.id}
              onChoose={() => {
                setTypeName(type.name);
                setNaming('');
              }}
            />
          ))}
          {/* **A box, not a "new type…" chip that turns into one**: choosing
              from what is there and naming what is not are one question, and
              two states for one question is what the Inbox's row already
              refuses. Dashed, because what it makes is not there yet.

              A line of its own on a phone rather than the end of the chip row,
              which is where the artboard puts it: sharing that row leaves it
              whatever is left over - 130px behind two chips, which cuts the
              placeholder in half. Found in the browser at 375px. */}
          <input
            value={naming}
            onChange={(e) => setNaming(e.target.value)}
            placeholder="or name a new one…"
            aria-label="Name a new type"
            maxLength={60}
            className="min-h-11 w-full rounded-full border border-dashed border-black/20 bg-transparent px-4 text-[15px] text-ink outline-none placeholder:text-ink-faint focus:border-accent focus:ring-2 focus:ring-accent-soft/40 sm:min-h-0 sm:w-[170px] sm:py-[7px] sm:text-sm"
          />
        </Choice>

        <Choice label="Where" optional>
          {/* First and selected to start with: the whole point of capturing
              here is not having to answer this yet. */}
          <Chip name="Any workspace" chosen={where === null} onChoose={() => setWhere(null)} />
          {workspaces.map((workspace: Workspace) => (
            <Chip
              key={workspace.id}
              name={workspace.name}
              dot={workspace.color}
              chosen={where === workspace.id}
              onChoose={() => setWhere(workspace.id)}
            />
          ))}
          <span className="hidden text-xs text-ink-faint sm:inline">
            Leave it on Any workspace and it waits in every Inbox.
          </span>
        </Choice>

        {/* Last on a phone and pinned to the bottom of the screen, where a
            thumb is; beside the note's own hint at a desk, where a mouse is
            already. */}
        <div className="order-last mt-auto flex items-center gap-3.5 sm:order-none sm:mt-[22px]">
          <button
            type="submit"
            disabled={busy}
            className="milled min-h-13 w-full rounded-[10px] bg-accent text-[17px] font-medium text-white hover:bg-accent-deep disabled:opacity-50 sm:min-h-0 sm:w-auto sm:flex-none sm:rounded-md sm:px-[22px] sm:py-[11px] sm:text-[15px]"
          >
            Capture
          </button>
          <span className="hidden text-[13px] text-ink-faint sm:inline">
            {SHORTCUT} · the box empties and the cursor stays put
          </span>
        </div>

        {refused && (
          <p role="alert" className="order-last pt-2 text-sm text-over sm:order-none">
            {refused}
          </p>
        )}

        {/* Nothing at all until something has been captured: an empty list
            under an empty box is a heading saying you have done nothing. */}
        {justCaptured.length > 0 && (
          <section
            aria-labelledby={JUST_CAPTURED}
            className="mt-[18px] border-t border-[rgb(41_43_49/0.08)] pt-3 sm:mt-auto"
          >
            <div className="flex items-baseline gap-2">
              <h2
                id={JUST_CAPTURED}
                className="text-xs font-semibold tracking-[0.11em] text-accent-deep uppercase"
              >
                Just captured
              </h2>
              <span className="ml-auto text-xs tabular-nums text-ink-faint sm:ml-0">
                {justCaptured.length}
              </span>
            </div>
            <ul className="mt-2 sm:mt-1">
              {justCaptured.map((one) => (
                <Row key={one.at} captured={one} types={known} workspaces={workspaces} />
              ))}
            </ul>
          </section>
        )}
      </form>
    </section>
  );
}

/** Fixed rather than generated: one heading, and only one of these on a screen. */
const JUST_CAPTURED = 'just-captured';

/**
 * The key that captures, said the way this keyboard says it. A Mac reads ⌘ and
 * nothing else does, and a hint naming the wrong key is worse than none.
 */
const SHORTCUT =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent)
    ? '⌘↵'
    : 'Ctrl ↵';

/** One note this page has captured, as this page remembers it. */
interface Captured {
  /** When, which is also its identity: two captures cannot share a millisecond. */
  at: number;
  message: string;
  typeId: string | undefined;
  /** What the type was called when it was chosen, for the moment before it is read back. */
  typeName: string;
  /** Null where it was left on *Any workspace*. */
  workspaceId: string | null;
}

/**
 * One labelled row of chips.
 *
 * The label stands beside the chips at a desk and above them on a phone, which
 * is the one difference between the two artboards' rows: a 74px column of label
 * beside a wrapping row of 44px chips leaves no room for the chips.
 */
function Choice({
  label,
  optional = false,
  children,
}: {
  label: string;
  optional?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-3.5 flex flex-col gap-2 sm:mt-5 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2">
      <span
        aria-hidden="true"
        className="text-[11px] font-semibold tracking-[0.11em] text-ink-faint uppercase sm:w-[74px] sm:shrink-0 sm:text-xs"
      >
        {label}
        {optional && (
          <span className="text-[11px] font-normal tracking-normal normal-case sm:hidden">
            {' '}
            — optional
          </span>
        )}
      </span>
      {/* Named for a screen reader by the same word the label shows, which is
          why the label itself is hidden from one: a group and a stray line of
          text saying the same thing is the word twice. */}
      <div
        role="group"
        aria-label={label}
        className="flex min-w-0 flex-wrap items-center gap-2 sm:flex-1"
      >
        {children}
      </div>
    </div>
  );
}

/**
 * One choice, pressed or not. A button rather than a radio: what these choose
 * is one of a list that can grow while you look at it, and `aria-pressed` says
 * which is chosen without a fieldset around every row.
 */
function Chip({
  name,
  dot,
  chosen,
  onChoose,
}: {
  name: string;
  dot?: string;
  chosen: boolean;
  onChoose: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={chosen}
      onClick={onChoose}
      /* 44px high on a phone and no taller than it needs to be at a desk: a
         chip is one of a row of targets under a thumb there, and one of a row
         of words beside a pointer here. */
      className={`inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full border px-4 text-[15px] sm:min-h-0 sm:py-[7px] sm:text-sm ${
        chosen
          ? 'border-accent bg-accent-tint font-medium text-accent-deep'
          : 'border-black/10 bg-white text-ink'
      }`}
    >
      {dot && (
        <span
          aria-hidden="true"
          className="size-2 shrink-0 rounded-full"
          style={{ backgroundColor: dot }}
        />
      )}
      {name}
    </button>
  );
}

/**
 * One row of what was just captured: what you wrote, what kind of thing it is,
 * where it went and how long ago.
 *
 * **The type is looked up rather than remembered**, so a type made by this very
 * capture wears its own colour the moment the account has read it back - the
 * name it was given is only what is shown until then.
 */
function Row({
  captured,
  types,
  workspaces,
}: {
  captured: Captured;
  types: readonly ItemType[];
  workspaces: readonly Workspace[];
}) {
  const type = types.find((one) => one.id === captured.typeId);
  const name = type?.name ?? captured.typeName;
  const workspace = workspaces.find((one) => one.id === captured.workspaceId);

  return (
    <li className="flex flex-col gap-0.5 border-b border-black/5 py-2 last:border-0 sm:flex-row sm:items-center sm:gap-2 sm:py-[7px]">
      <span className="flex min-w-0 items-center gap-2 sm:flex-1">
        <span
          aria-hidden="true"
          className="size-2 shrink-0 rounded-full"
          style={{ backgroundColor: type?.color ?? 'var(--color-ink-faint)' }}
        />
        <span className="min-w-0 truncate text-[15px] sm:text-sm">{captured.message}</span>
      </span>
      <span className="flex shrink-0 items-center gap-2 pl-4 text-xs sm:pl-0">
        {name && <span className="text-accent-deep">{name}</span>}
        <span className="rounded-full bg-accent-tint px-1.5 text-accent-deep">
          {workspace?.name ?? 'Any workspace'}
        </span>
        <span className="tabular-nums text-ink-faint">{howLongAgo(Date.now() - captured.at)}</span>
      </span>
    </li>
  );
}
