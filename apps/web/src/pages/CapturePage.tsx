import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ItemType, Workspace } from '@cockpit/shared';
import { snapshotQuery, workspacesQuery } from '../api/queries';
import { browserStore, workspaceToCaptureFrom } from '../lastVisited';
import { howLongAgo, useCapture } from '../capture';
import { NO_TYPES, typesOffered } from '../itemTypes';

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
   *
   * **Worked out on every render, against the list as it stands.** The route
   * asks the same question to know which snapshot to wait for, and that is a
   * different question: it is answered once, at load. This one has to keep
   * being answered, because the workspace can go while you sit here - deleting
   * one that is neither the last nor the screen behind you leaves you on this
   * page on purpose (components/WorkspaceTabs.tsx), and a frozen answer
   * would then point at a workspace whose snapshot is a 404, leaving nothing to
   * capture with and no chip to say so.
   */
  const from = workspaceToCaptureFrom(browserStore(), workspaces);

  /**
   * The workspace you came from, read for its types *and* its items: one read
   * for both halves of the Type row, and the same query key the shell already
   * holds. **Not the account's types as a resource of their own** - nothing
   * ahead of this page fetches that one, so it arrived after the page was drawn
   * and left it unable to capture (`CapturePage.test.tsx`, "the capture page is
   * drawn only once it can capture"). `itemTypesQuery` stays for the window
   * that manages them, which really is outside every workspace.
   */
  const snapshot = useQuery({ ...snapshotQuery(from ?? ''), enabled: Boolean(from) });

  const known = snapshot.data?.itemTypes ?? [];
  const offered = typesOffered(known, snapshot.data?.items ?? []);
  /**
   * Whether the account has *said* what types it has, which is not the same as
   * this page having none to show: `?? []` above turns a question still in
   * flight into an empty list, and "No types yet" is a claim about the account
   * rather than about what has arrived. Asked of the field rather than of the
   * snapshot around it, because a stored copy can predate the field - the same
   * guard the Inbox's row carries (components/CaptureForm.tsx).
   */
  const answered = snapshot.data?.itemTypes !== undefined;

  const [message, setMessage] = useState('');
  /**
   * The type pressed, by id, or the empty string for *not yet pressed one* -
   * which is not an answer, only the absence of one. What that resolves to is
   * `chosen` below.
   *
   * It was a name while a name that matched nothing was a second answer to this
   * question - the box beside the chips, which made a type. Types are now made
   * in the window they are managed in ("Make a type where types are managed,
   * not while capturing", issue 203), so every answer this row can give is one
   * of the chips and an id says it exactly.
   */
  const [typeId, setTypeId] = useState('');
  /** Which workspace it belongs to, or null for *Any workspace*. */
  const [where, setWhere] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [justCaptured, setJustCaptured] = useState<Captured[]>([]);
  const form = useRef<HTMLFormElement>(null);
  const { ask, busy } = useCapture();

  /**
   * The type chosen, as against the one that was pressed: **every Item has a
   * Type**, so a row that has not been pressed yet and one whose type was
   * deleted in another tab both fall back to the type used last rather than to
   * none. Unlike the Where row one line down, which keeps *Any workspace* as a
   * real answer - not saying where it goes yet is the point of capturing here,
   * and not saying what it is never was.
   *
   * Undefined only where there is nothing to fall back to - an account with no
   * types, or an answer that has not arrived yet - and capture waits either
   * way, because there is no type to give.
   */
  const chosen = offered.find((type) => type.id === typeId) ?? offered[0];

  /**
   * Where it belongs, as against which chip was pressed: a workspace deleted in
   * another tab takes its chip off this row, and what was chosen then falls
   * back to *Any workspace* rather than to a capture the server will refuse.
   * The screen and the capture agree either way.
   */
  const belongsTo = workspaces.some((one) => one.id === where) ? where : null;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = message.trim();
    // Nothing written is nothing to say anything about.
    if (!trimmed) return;

    /**
     * **A capture this page cannot make is said out loud, never swallowed** -
     * and said as the reason it actually is, because the three do not have the
     * same answer. The button is disabled through all of them, so it is the
     * shortcut that arrives here, and it used to return having done nothing and
     * said nothing: that silence is "Find out why the
     * capture-into-a-named-workspace walk fails intermittently" (issue 219)
     * itself, and every fix that only narrows a window leaves the next one
     * open. The note stays in the box whichever it is, and this is what says
     * why it is still there.
     *
     * **Nowhere to capture into** is the account having no workspace left, not
     * a read in flight: `from` falls back to the first workspace there is, so
     * it is only empty when there are none (`lastVisited.ts`). Deleting your
     * last one from another tab lands you here - this client is told the list
     * changed and nothing sends you anywhere - and "try again" would be a
     * promise nothing can keep.
     */
    if (!from) {
      setRefused(NO_WORKSPACE);
      return;
    }
    if (!chosen) {
      setRefused(answered && offered.length === 0 ? NO_TYPES : STILL_READING);
      return;
    }

    ask(
      {
        message: trimmed,
        typeId: chosen.id,
        // The workspace chosen, or the one this was captured from - and the
        // difference between the two is the whole of `decided`.
        workspaceId: belongsTo ?? from,
        decided: belongsTo !== null,
      },
      {
        asking: () => {
          setMessage('');
          setRefused(null);
        },
        captured: (captureType) => {
          setJustCaptured((already) => [
            { at: Date.now(), message: trimmed, typeId: captureType, workspaceId: belongsTo },
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
        {/* **A box of several lines, one step above the page in size and no
            more.** What gets captured is a thought as it was had, which is
            often two sentences and sometimes a paragraph; one line high made
            every one of them scroll sideways past itself while it was being
            written. The room comes from the height, not from the type - at 20px
            against chips of 14 it read as a headline being typed rather than a
            note.

            16px is a floor rather than a preference: mobile Safari zooms the
            whole page whenever a focused field is set smaller than that, so
            this box does not follow the chips down to `text-sm`.

            Resizable at a desk and not on a phone, where there is no room to
            grow into and the handle is one more thing under a thumb. */}
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="What is on your mind?"
          aria-label="What is on your mind?"
          autoFocus
          rows={4}
          className="mt-2.5 w-full resize-none rounded-md border border-black/10 bg-white p-3 text-base leading-[1.5] text-ink shadow-[inset_0_1px_2px_rgb(41_43_49/0.06)] outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft/40 sm:mt-4 sm:min-h-56 sm:resize-y sm:px-5 sm:py-[18px]"
        />

        {/* The box that used to sit at the end of this row, dashed, naming a
            type that was not there yet, is gone: types are made in the window
            they are managed in ("Make a type where types are managed, not while
            capturing", issue 203), so every answer to this question is now one
            of the chips.

            **And there is no chip for none.** Every Item is some kind of thing,
            so this row has no way back to having said nothing - where *No type*
            sat, the type you used last is already lit. What a front door with
            nobody to press a chip does is auto-detection's, not a blank. */}
        <Choice label="Type">
          {offered.map((type) => (
            <Chip
              key={type.id}
              name={type.name}
              dot={type.color}
              chosen={chosen?.id === type.id}
              onChoose={() => setTypeId(type.id)}
            />
          ))}
          {/* Nothing to press, so the row says why rather than standing empty:
              deleting every type is what gets you here, and making one is what
              gets you out. Only once the account has answered - before that
              there are no chips either, and this would be saying the account
              holds nothing when nobody has looked. */}
          {answered && offered.length === 0 && (
            <span className="text-[15px] text-ink-faint sm:text-sm">{NO_TYPES}</span>
          )}
        </Choice>

        <Choice label="Where" optional>
          {/* First and selected to start with: the whole point of capturing
              here is not having to answer this yet. */}
          <Chip name="Any workspace" chosen={belongsTo === null} onChoose={() => setWhere(null)} />
          {workspaces.map((workspace: Workspace) => (
            <Chip
              key={workspace.id}
              name={workspace.name}
              dot={workspace.color}
              chosen={belongsTo === workspace.id}
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
            disabled={busy || !chosen}
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
 * What the shortcut says when it arrives before the workspace this captures
 * from has been read. Names the note as kept, because that is the question
 * somebody who just pressed it is asking.
 */
export const STILL_READING = 'Still reading your workspace — your note is safe, try that again.';

/**
 * And what it says when there is no workspace to capture into at all. Named
 * where one is made, the way the types' line names where a type is made, rather
 * than inviting a retry that cannot come good.
 *
 * The `+` rather than a menu: making a workspace is the strip's own control,
 * and the window this used to name is gone ("Change a workspace or a dashboard
 * on the tab it is", issue 255).
 */
export const NO_WORKSPACE =
  'No workspace to capture into — your note is safe. Make one with the + beside the tabs.';

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
  /** Which type it was given, which every capture has. */
  typeId: string;
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
 * **The type is looked up rather than remembered**, so a row renamed or
 * recoloured in the window types are managed in says so here too, without this
 * list keeping a second copy of a name that can go stale behind it.
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
        {type && <span className="text-accent-deep">{type.name}</span>}
        <span className="rounded-full bg-accent-tint px-1.5 text-accent-deep">
          {workspace?.name ?? 'Any workspace'}
        </span>
        <span className="tabular-nums text-ink-faint">{howLongAgo(Date.now() - captured.at)}</span>
      </span>
    </li>
  );
}
