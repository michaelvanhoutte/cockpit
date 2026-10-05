import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { prioritySchema, uuidv7, type ItemType, type Priority, type Workspace } from '@cockpit/shared';
import { CommandRefused, uploadAttachment } from '../api/client';
import { snapshotQuery, workspacesQuery } from '../api/queries';
import { checkAttachmentFiles, formatFileSize, takesFiles } from '../attachmentQueue';
import { browserStore, workspaceToCaptureFrom } from '../lastVisited';
import { howLongAgo, useCapture } from '../capture';
import { stateOf, whatGoesBack, type EntryState, type OutboxEntry } from '../captureOutbox';
import { fileOf, useOutbox, useWaitingCaptures } from '../captureOutboxSender';
import { useDockedItem } from '../itemForm';
import { NO_TYPES, typesOffered } from '../itemTypes';
import { dueDateLabel } from '../dueDate';
import { DUE_DATE_SHORTCUTS } from '../dueDateShortcuts';
import { PRIORITY_LABELS } from '../priority';
import {
  DICTATION_LANGUAGES,
  appendPhrase,
  replacePhrase,
  useDictation,
  type Dictation,
  type EngineFactory,
} from '../dictation';

/**
 * The Capture form itself: the note, the types as chips, where it goes as one
 * more row of chips, and what was just captured under it ("Capture Page",
 * artboards 2a and 2c).
 *
 * **One form in two places** ("Capture over the screen you are on, and open it
 * with C", issue 536): the page a phone and a typed `/capture` open
 * (pages/CapturePage.tsx), and the window the header's Capture tab and `C` open
 * over the screen at a desk (components/CaptureWindow.tsx). Both are the same
 * thing to capture with, so both draw this.
 *
 * **Capturing never waits on the network** ("Keep a capture made offline, and
 * send it once a connection gets through", issue 610): Capture writes the note
 * and its files to the outbox (`captureOutboxSender.tsx`), the box empties once
 * that write is done, and the outbox sends it. *Just captured* is drawn from the
 * outbox, so a note still waiting survives a reload. Only where the outbox
 * cannot be written - a private window, storage refused - does Capture send
 * directly, through `useCapture`, and refuse offline as it always did.
 *
 * **Where starts on `startsIn`**, the workspace you are in, or on *Any
 * workspace* where Capture was reached from outside one. A different choice
 * holds for as long as this is mounted: the window unmounts it on closing, so
 * reopening starts on the current workspace again.
 */
export function CaptureNote({
  startsIn,
  dictating,
}: {
  startsIn: string | null;
  /** Where speech comes from and where the language is kept: the browser's own, unless a test hands in a fake. */
  dictating?: { engine?: EngineFactory | null; store?: Storage | undefined } | undefined;
}) {
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
   * guard the Inbox's row used to carry.
   */
  const answered = snapshot.data?.itemTypes !== undefined;

  const [message, setMessage] = useState('');
  /**
   * What the engine is still working out, shown after the note and replaced by
   * its final reading ("Dictate a note in Capture", issue 714). Kept apart from
   * `message` so it can be replaced rather than added to; it joins the note when
   * the engine settles on it, or when dictation stops with it still unsettled.
   */
  const [provisional, setProvisional] = useState('');
  const dictation = useDictation({
    ...dictating,
    onPhrase: (text, final, replaces) => {
      if (final) {
        setMessage((was) => (replaces ? replacePhrase(was, replaces, text) : appendPhrase(was, text)));
      } else setProvisional(text);
    },
  });
  const shown = appendPhrase(message, provisional);
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
  const [where, setWhere] = useState<string | null>(startsIn);
  const [refused, setRefused] = useState<string | null>(null);
  /**
   * What the strip inside the box has chosen ("Set a priority and a due date
   * while capturing", issue 611): neither until pressed, and neither again once
   * a capture has been kept - unlike Type and Where, which carry over, because
   * a deadline belongs to the one note it was set for. A refused capture puts
   * both back with the note.
   *
   * The due date is the day alone: the shortcuts are always three different
   * days, so the lit one is read off the day however it was reached.
   */
  const [priority, setPriority] = useState<Priority | null>(null);
  const [due, setDue] = useState<string | null>(null);
  /**
   * What landed while this form was open. The outbox forgets a capture once it
   * has landed, so this is what keeps its row - with its time - until the form
   * closes; after a reload only what is still waiting or refused is listed.
   */
  const [landedHere, setLandedHere] = useState<Captured[]>([]);
  /** The refused captures put back while this form was open, whose rows no longer offer it. */
  const [putBackRows, setPutBack] = useState<ReadonlySet<string>>(new Set());
  const putBackHere = useRef(new Set<string>());
  const form = useRef<HTMLFormElement>(null);
  const { ask, busy } = useCapture();
  const queryClient = useQueryClient();
  const outbox = useOutbox();
  const waiting = useWaitingCaptures();

  /**
   * With a form docked open, it moves to what was just captured once that has
   * landed ("Let the item's form dock to the side of the screen instead of
   * opening as a dialog", issue 481), leaving the keyboard in the box - only
   * for a note captured here, not for an older one the outbox happens to send
   * while this is open.
   */
  const dock = useDockedItem();
  const dockNow = useRef(dock);
  dockNow.current = dock;
  const madeHere = useRef(new Set<string>());
  useEffect(
    () =>
      outbox.onLanding(({ kind, entry }) => {
        if (kind === 'note' && madeHere.current.has(entry.id) && dockNow.current.openId !== null) {
          dockNow.current.show(entry.id, { keepFocus: true });
        }
        if (kind === 'whole') {
          setLandedHere((was) => [
            {
              id: entry.id,
              at: Date.parse(entry.capturedAt),
              message: entry.message,
              typeId: entry.typeId,
              workspaceId: entry.decided ? entry.workspaceId : null,
            },
            ...was.filter((one) => one.id !== entry.id),
          ]);
        }
      }),
    [outbox],
  );

  /**
   * A file dropped or pasted before the note is captured ("Drop files and
   * paste images while capturing a message", issue 557). There is no Item
   * yet to attach it to, so it waits here as a chip, and uploads once
   * Capture has made one.
   */
  const [queued, setQueued] = useState<QueuedFile[]>([]);
  const [queueError, setQueueError] = useState<string | null>(null);
  /** A file being dragged over the form anywhere a drop would queue it. */
  const [filesOver, setFilesOver] = useState(false);
  /** True while Capture is writing to the outbox. */
  const keeping = useRef(false);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const queuedRef = useRef(queued);
  queuedRef.current = queued;
  // Revokes whatever object URLs are still outstanding on the way out - a
  // queued file's own thumbnail is the one thing here that leaks if nobody
  // frees it.
  useEffect(
    () => () => {
      for (const file of queuedRef.current) if (file.previewUrl) URL.revokeObjectURL(file.previewUrl);
    },
    [],
  );

  const queueFiles = (files: Iterable<File>) => {
    const { accepted, rejections } = checkAttachmentFiles(files);
    setQueueError(rejections.length > 0 ? rejections.join(' ') : null);
    if (accepted.length === 0) return;
    setQueued((was) => [...was, ...accepted.map(toQueued)]);
  };

  /**
   * **Put back**: a refused capture's note and files return to the box, and
   * only then is its entry deleted - so there is no moment where the note is
   * in neither. Where only a file was refused the note already landed, and
   * just the file comes back.
   *
   * **Once per entry.** Its row loses the button the moment it is pressed, and
   * where the entry cannot then be deleted it stays listed without one -
   * pressing again would put the same note in the box twice.
   */
  const putBack = async (entry: OutboxEntry) => {
    if (putBackHere.current.has(entry.id)) return;
    putBackHere.current.add(entry.id);
    setPutBack((was) => new Set(was).add(entry.id));
    const back = whatGoesBack(entry);
    if (back.message !== null) {
      const note = back.message;
      setMessage((was) => (was.trim() ? `${was}\n${note}` : note));
      setTypeId(entry.typeId);
      setWhere(entry.decided ? entry.workspaceId : null);
      // Back with the note they were set for, unless something has been chosen since.
      if (entry.priority) setPriority((was) => was ?? entry.priority ?? null);
      if (entry.dueDate) setDue((was) => was ?? entry.dueDate!);
    }
    const files = back.files.map(fileOf);
    setQueued((was) => [...was, ...files.map(toQueued)]);
    setRefused(null);
    try {
      await outbox.remove(entry.id);
    } catch {
      setRefused(STILL_LISTED);
    }
  };

  const removeQueued = (id: string) => {
    setQueued((was) => {
      const gone = was.find((file) => file.id === id);
      if (gone?.previewUrl) URL.revokeObjectURL(gone.previewUrl);
      return was.filter((file) => file.id !== id);
    });
  };

  /**
   * Attaches whatever was queued to the Item Capture just made, one at a
   * time and without the box waiting on any of it - a second capture started
   * while these are still uploading reads its own queue, not this one.
   *
   * A file that fails says so by name and leaves the others to keep
   * uploading: the capture already landed, and nothing here can undo it.
   */
  const uploadQueued = async (files: QueuedFile[], itemId: string, workspaceId: string) => {
    if (files.length === 0) return;
    // Collected across the whole batch, not set as each one fails - a
    // rejection two files back must not be a message the next file's own
    // failure quietly clears.
    const failures: string[] = [];
    for (const queuedFile of files) {
      try {
        await uploadAttachment({
          itemId,
          workspaceId,
          attachmentId: queuedFile.id,
          commandId: uuidv7(),
          file: queuedFile.file,
        });
      } catch (failure) {
        failures.push(
          failure instanceof CommandRefused
            ? failure.message
            : `"${queuedFile.file.name}" could not be attached.`,
        );
      } finally {
        if (queuedFile.previewUrl) URL.revokeObjectURL(queuedFile.previewUrl);
      }
    }
    if (failures.length > 0) setQueueError(failures.join(' '));
    void queryClient.invalidateQueries({ queryKey: ['snapshot', workspaceId] });
  };

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
    // Listening stops with the press, and what was still being recognised stays
    // in the note: `shown` already holds it, and so does the box once it empties.
    const trimmed = shown.trim();
    dictation.stop();
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

    // The workspace this is captured against, the same one `ask` is given
    // below - read once, so what the queued files upload against on success
    // is exactly what the note itself was captured against.
    const targetWorkspace = belongsTo ?? from;
    // What was queued when Capture was pressed, not the state as it stands
    // by the time an answer comes back - a second capture may have already
    // queued files of its own by then.
    const queuedAtSubmit = queued;
    const priorityAtSubmit = priority;
    const dueAtSubmit = due;
    const what = {
      message: trimmed,
      typeId: chosen.id,
      // The workspace chosen, or the one this was captured from - and the
      // difference between the two is the whole of `decided`.
      workspaceId: targetWorkspace,
      decided: belongsTo !== null,
      ...(priorityAtSubmit ? { priority: priorityAtSubmit } : {}),
      ...(dueAtSubmit ? { dueDate: dueAtSubmit } : {}),
    };
    // Empties the box of what was captured and nothing typed or dropped since.
    const emptied = () => {
      setMessage((was) => (was.trim() === trimmed ? '' : was));
      setPriority((was) => (was === priorityAtSubmit ? null : was));
      setDue((was) => (was === dueAtSubmit ? null : was));
      setRefused(null);
      setQueued((was) => was.filter((file) => !queuedAtSubmit.includes(file)));
      setQueueError(null);
    };

    // One write at a time, so a second press during it cannot keep the same
    // note twice.
    if (keeping.current) return;
    keeping.current = true;
    const id = uuidv7();
    // Before the write, since sending starts behind it and can land first.
    madeHere.current.add(id);
    void outbox
      .add({ ...what, id, files: queuedAtSubmit.map(({ id: fileId, file }) => ({ id: fileId, file })) })
      .then(
        () => {
          // Only now, with the note kept: a write that never finished leaves it in the box.
          for (const file of queuedAtSubmit) if (file.previewUrl) URL.revokeObjectURL(file.previewUrl);
          emptied();
        },
        () => {
          madeHere.current.delete(id);
          sendDirectly();
        },
      )
      .finally(() => {
        keeping.current = false;
      });

    /** Where the outbox cannot be written: sent at once, and refused offline, as before it existed. */
    function sendDirectly() {
      ask(what, {
        asking: emptied,
        captured: (captureType, itemId) => {
          setLandedHere((already) => [
            { id: itemId, at: Date.now(), message: trimmed, typeId: captureType, workspaceId: belongsTo },
            ...already,
          ]);
          void uploadQueued(queuedAtSubmit, itemId, targetWorkspace);
        },
        refused: (why) => {
          setMessage(trimmed);
          setPriority((was) => was ?? priorityAtSubmit);
          setDue((was) => was ?? dueAtSubmit);
          setQueued((was) => [...queuedAtSubmit, ...was]);
          setRefused(why);
        },
      });
    }
  };

  /**
   * Every row of *Just captured*, newest first: what the outbox still holds
   * for you, waiting or refused, and what landed while this was open.
   */
  const stillHeld = new Set(waiting.map((entry) => entry.id));
  const rows: Row[] = [
    ...waiting.map((entry) => ({
      id: entry.id,
      at: Date.parse(entry.capturedAt),
      message: entry.message,
      typeId: entry.typeId,
      workspaceId: entry.decided ? entry.workspaceId : null,
      state: stateOf(entry),
      entry,
    })),
    ...landedHere.filter((one) => !stillHeld.has(one.id)).map((one) => ({ ...one, state: null, entry: null })),
  ].sort((a, b) => b.at - a.at);

  return (
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
      // A file dropped anywhere on the form queues it as an attachment,
      // never as text - the box holds a thought, not an image (docs/ideas.md,
      // "Capture and the task creator"). Never left to the browser, which
      // would otherwise open the file in Cockpit's place.
      onDragOver={(event) => {
        if (!takesFiles(event)) return;
        event.preventDefault();
        setFilesOver(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFilesOver(false);
      }}
      onDrop={(event) => {
        if (!takesFiles(event)) return;
        event.preventDefault();
        setFilesOver(false);
        if (event.dataTransfer.files.length > 0) queueFiles(Array.from(event.dataTransfer.files));
      }}
      // Pasted anywhere on the form, including with the cursor in the
      // message box: unlike the Item form's own description text, this box
      // is plain text and cannot hold an image, so there is no second branch
      // where the paste is the field's own.
      onPaste={(event) => {
        const files = Array.from(event.clipboardData.files);
        if (files.length === 0) return;
        event.preventDefault();
        queueFiles(files);
      }}
      className={`flex min-h-0 flex-1 flex-col${filesOver ? ' ring-2 ring-accent' : ''}`}
    >
      {/* On a phone the button and any refusal are ordered up under the note
          (`order-*`) and the rest follows in the order it is written here,
          which is the desk's. */}
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
      {/* The note and, along its bottom edge, the strip that sets a priority
          and a due date: one box rather than a row of its own, which took too
          much room. The border and the focus ring belong to the box, so the
          strip reads as inside the note rather than under it. */}
      <div className="order-1 mt-2.5 flex w-full flex-col rounded-md border border-shade/10 bg-white shadow-field focus-within:border-accent focus-within:ring-2 focus-within:ring-accent-soft/40 sm:order-none sm:mt-4 sm:min-h-56">
        <textarea
          value={shown}
          onChange={(e) => {
            // Typing over what was just heard makes it part of the note, and the
            // engine must not deliver it again, as a final or as a longer reading.
            dictation.forgetPhrase();
            setProvisional('');
            setMessage(e.target.value);
          }}
          placeholder="What is on your mind?"
          aria-label="What is on your mind?"
          autoFocus
          rows={4}
          className="w-full flex-1 resize-none rounded-md bg-transparent p-3 text-base leading-[1.5] text-ink outline-none sm:resize-y sm:px-5 sm:py-[18px]"
        />
        <PriorityAndDue
          priority={priority}
          onPriority={setPriority}
          due={due}
          onDue={setDue}
          disabled={busy}
          dictation={dictation}
        />
      </div>

      {/* Files queued to attach once Capture is pressed - shown whether or
          not anything is queued yet, the same "Drag a file here, or" plus
          Add button the Item form's own Attachments box always shows, so
          there is something on screen naming drop, paste and a picker all
          three before anyone has tried any of them. */}
      <div
        className={`order-1 mt-2 flex flex-col gap-1.5 rounded-md border border-dashed px-3 py-2 sm:order-none ${
          filesOver ? 'border-accent bg-accent-tint' : 'border-shade/10'
        }`}
      >
        {queued.map((file) => (
          <div
            key={file.id}
            className="flex items-center gap-2 rounded-md border border-shade/10 bg-white px-3 py-2 text-sm"
          >
            {file.previewUrl ? (
              <img
                src={file.previewUrl}
                alt=""
                className="h-8 w-8 shrink-0 rounded object-cover"
              />
            ) : (
              <span className="shrink-0 text-lg" aria-hidden="true">
                📄
              </span>
            )}
            <span className="min-w-0">
              <span className="block max-w-40 truncate font-medium text-ink">{file.file.name}</span>
              <span className="block text-xs text-ink-faint">{formatFileSize(file.file.size)}</span>
            </span>
            <button
              type="button"
              onClick={() => removeQueued(file.id)}
              title="Remove"
              aria-label={`Remove ${file.file.name}`}
              className="shrink-0 rounded-md border border-shade/10 px-2 text-sm text-ink-faint hover:border-accent hover:bg-accent-tint hover:text-ink disabled:opacity-50"
            >
              ✕
            </button>
          </div>
        ))}
        {queued.length === 0 && (
          <p className="text-sm text-ink-faint">
            Drag a file here, <span className="hidden sm:inline">paste an image with {PASTE_KEY}, </span>
            or
          </p>
        )}
        <button
          type="button"
          onClick={() => attachmentInputRef.current?.click()}
          className="self-start rounded-md border border-shade/10 px-3 py-1.5 text-sm text-ink-soft hover:border-accent hover:bg-accent-tint disabled:opacity-50"
        >
          Add
        </button>
        <input
          ref={attachmentInputRef}
          type="file"
          multiple
          aria-label="Files to attach"
          className="hidden"
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) queueFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </div>
      {queueError && (
        <p role="alert" className="order-1 pt-1 text-sm text-over sm:order-none">
          {queueError}
        </p>
      )}

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

      {/* Directly under the note on a phone, so it stays above the on-screen
          keyboard and the browser's toolbars; below the Where row, beside the
          note's own hint, at a desk. */}
      <div className="order-2 mt-3 flex items-center gap-3.5 sm:order-none sm:mt-[22px]">
        <button
          type="submit"
          disabled={busy || !chosen}
          className="milled min-h-13 w-full rounded-md bg-accent text-[17px] font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50 sm:min-h-0 sm:w-auto sm:flex-none sm:rounded-md sm:px-[22px] sm:py-[11px] sm:text-[15px]"
        >
          Capture
        </button>
        <span className="hidden text-[13px] text-ink-faint sm:inline">
          {SHORTCUT} · the box empties and the cursor stays put
        </span>
      </div>

      {refused && (
        <p role="alert" className="order-3 pt-2 text-sm text-over sm:order-none">
          {refused}
        </p>
      )}

      {/* Nothing at all until something has been captured: an empty list
          under an empty box is a heading saying you have done nothing. */}
      {rows.length > 0 && (
        <section
          aria-labelledby={JUST_CAPTURED}
          className="order-5 mt-[18px] border-t border-shade/8 pt-3 sm:order-none sm:mt-auto"
        >
          <div className="flex items-baseline gap-2">
            <h2
              id={JUST_CAPTURED}
              className="text-xs font-semibold tracking-[0.11em] text-accent-deep uppercase"
            >
              Just captured
            </h2>
            <span className="ml-auto text-xs tabular-nums text-ink-faint sm:ml-0">
              {rows.length}
            </span>
          </div>
          <ul className="mt-2 sm:mt-1">
            {rows.map((one) => {
              const { entry } = one;
              return (
                <CapturedRow
                  key={one.id}
                  captured={one}
                  types={known}
                  workspaces={workspaces}
                  onPutBack={entry && !putBackRows.has(entry.id) ? () => void putBack(entry) : null}
                />
              );
            })}
          </ul>
        </section>
      )}
    </form>
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
 * on the tab it is", issue 267).
 */
export const NO_WORKSPACE =
  'No workspace to capture into — your note is safe. Make one with the + beside the tabs.';

/** What is said where a capture was put back but could not be taken off the list. */
export const STILL_LISTED = 'Put back in the box, but it could not be taken off this list — it will not be sent.';

/**
 * The key that captures, said the way this keyboard says it. A Mac reads ⌘ and
 * nothing else does, and a hint naming the wrong key is worse than none.
 */
const SHORTCUT = isAMac() ? '⌘↵' : 'Ctrl ↵';

function isAMac(userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : ''): boolean {
  return /Mac|iPhone|iPad/.test(userAgent);
}

/** The key that pastes, said the way `SHORTCUT` says its own. */
export function pasteKeyFor(userAgent: string): string {
  return isAMac(userAgent) ? '⌘V' : 'Ctrl V';
}

const PASTE_KEY = isAMac() ? '⌘V' : 'Ctrl V';

/** The flag's colour at each level, the same as an Inbox row's flag (`ItemRow.tsx`). */
const FLAG_COLOURS: Record<Priority, { lit: string; unlit: string }> = {
  low: { lit: 'border-priority-low bg-priority-low text-white', unlit: 'text-priority-low' },
  normal: { lit: 'border-priority-normal bg-priority-normal text-white', unlit: 'text-priority-normal' },
  high: { lit: 'border-priority-high bg-priority-high text-white', unlit: 'text-priority-high' },
};

const STRIP_BUTTON =
  'inline-flex min-h-9 shrink-0 items-center justify-center rounded-md border px-2 text-sm disabled:opacity-50 sm:min-h-0 sm:py-0.5 sm:text-xs';
const QUIET_BUTTON =
  'border-shade/10 bg-white text-ink-faint hover:border-accent hover:bg-accent-tint hover:text-ink';
const LIT_BUTTON = 'border-accent bg-accent-tint font-medium text-accent-deep';
/** The mic while listening: filled, where a lit chip is only tinted, so it cannot be mistaken for a choice made. */
const LIT_BUTTON_SOLID = 'border-accent bg-accent text-on-accent';

/**
 * The strip along the bottom of the note: three priority flags, then **Due**
 * with its shortcuts and a date picker. Every choice is one click and pressing
 * the lit one again clears it, so there is no *None* to offer.
 *
 * The level's name is the flag's hover title rather than a word beside it. A
 * day that is none of the shortcuts shows on the picker's own button, with a ✕
 * beside it.
 */
function PriorityAndDue({
  priority,
  onPriority,
  due,
  onDue,
  disabled,
  dictation,
}: {
  priority: Priority | null;
  onPriority: (priority: Priority | null) => void;
  due: string | null;
  onDue: (due: string | null) => void;
  disabled: boolean;
  dictation: Dictation;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const today = new Date();
  const custom =
    due !== null && !DUE_DATE_SHORTCUTS.some((s) => s.dueDate(today) === due) ? due : null;

  const openPicker = () => {
    const input = picker.current;
    if (!input) return;
    try {
      input.showPicker();
    } catch {
      // No picker to show: the input itself is the way in.
      input.focus();
      input.click();
    }
  };

  return (
    <>
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 pb-2 sm:px-4">
      <div role="group" aria-label="Priority" className="flex items-center gap-1.5">
        {prioritySchema.options.map((level) => {
          const lit = priority === level;
          return (
            <button
              key={level}
              type="button"
              disabled={disabled}
              aria-pressed={lit}
              aria-label={`${PRIORITY_LABELS[level]} priority`}
              title={`${PRIORITY_LABELS[level]} priority`}
              onClick={() => onPriority(lit ? null : level)}
              className={`${STRIP_BUTTON} w-9 sm:w-7 ${
                lit ? FLAG_COLOURS[level].lit : `border-shade/10 bg-white ${FLAG_COLOURS[level].unlit}`
              }`}
            >
              <span aria-hidden="true">⚑</span>
            </button>
          );
        })}
      </div>

      <div role="group" aria-label="Due" className="flex flex-wrap items-center gap-1.5">
        <span
          aria-hidden="true"
          className="text-[11px] font-semibold tracking-[0.11em] text-ink-faint uppercase sm:text-xs"
        >
          Due
        </span>
        {DUE_DATE_SHORTCUTS.map(({ label, dueDate }) => {
          const lit = due === dueDate(today);
          return (
            <button
              key={label}
              type="button"
              disabled={disabled}
              aria-pressed={lit}
              onClick={() => onDue(lit ? null : dueDate(new Date()))}
              className={`${STRIP_BUTTON} ${lit ? LIT_BUTTON : QUIET_BUTTON}`}
            >
              {label}
            </button>
          );
        })}
        <span className="relative inline-flex items-center gap-1">
          <button
            type="button"
            disabled={disabled}
            title="Pick a date"
            aria-label={custom ? `Due ${dueDateLabel(custom)}` : 'Pick a due date'}
            onClick={openPicker}
            className={`${STRIP_BUTTON} gap-1 ${custom ? LIT_BUTTON : QUIET_BUTTON}`}
          >
            <span aria-hidden="true">📅</span>
            {custom && <span>{dueDateLabel(custom)}</span>}
          </button>
          {custom && (
            <button
              type="button"
              disabled={disabled}
              title="Clear the due date"
              aria-label="Clear the due date"
              onClick={() => onDue(null)}
              className={`${STRIP_BUTTON} ${QUIET_BUTTON}`}
            >
              ✕
            </button>
          )}
          {/* Where the native picker is drawn from, which is why it sits over
              the button rather than nowhere: the popup opens beside the input
              it belongs to. Out of the tab order and the accessibility tree -
              the button is how it is reached. */}
          <input
            ref={picker}
            type="date"
            tabIndex={-1}
            aria-hidden="true"
            aria-label="Due date"
            value={due ?? ''}
            onChange={(e) => {
              const picked = e.target.value;
              onDue(picked || null);
            }}
            className="pointer-events-none absolute inset-0 w-full opacity-0"
          />
        </span>
      </div>

      {dictation.available && <Dictate dictation={dictation} disabled={disabled} />}
    </div>
    {dictation.error && (
      <p role="alert" className="px-3 pb-2 text-sm text-over sm:px-4">
        {dictation.error}
      </p>
    )}
    </>
  );
}

/**
 * The mic and the language it listens in, at the right end of the strip, drawn
 * only where the browser can recognise speech. The mic is the size of a flag;
 * it is filled and pulsing only once the engine has actually started
 * (`dictation.ts`), and the tag beside it is switched off while it listens.
 */
function Dictate({ dictation, disabled }: { dictation: Dictation; disabled: boolean }) {
  const { listening, language } = dictation;
  const { tag, name } = DICTATION_LANGUAGES[language];
  return (
    <div role="group" aria-label="Dictation" className="ml-auto flex items-center gap-1.5">
      <button
        type="button"
        onClick={dictation.toggle}
        disabled={disabled && !listening}
        aria-pressed={listening}
        aria-label="Dictate"
        title={listening ? 'Stop dictating' : 'Dictate the note'}
        className={`${STRIP_BUTTON} w-9 sm:w-7 ${
          listening ? `${LIT_BUTTON_SOLID} motion-safe:animate-pulse` : QUIET_BUTTON
        }`}
      >
        <svg viewBox="0 0 16 16" className="size-4" aria-hidden="true">
          <rect
            x="5.5"
            y="1.5"
            width="5"
            height="8"
            rx="2.5"
            fill={listening ? 'currentColor' : 'none'}
            stroke="currentColor"
            strokeWidth="1.4"
          />
          <path
            d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
      </button>
      <button
        type="button"
        onClick={dictation.toggleLanguage}
        disabled={listening}
        aria-label={`Dictation language: ${name}`}
        title={listening ? `Dictating in ${name}` : `Dictating in ${name}. Press to switch.`}
        className={`${STRIP_BUTTON} ${QUIET_BUTTON} font-medium tracking-[0.05em]`}
      >
        {tag}
      </button>
    </div>
  );
}

/** A file dropped or pasted before there is an Item to attach it to, waiting as a chip until Capture makes one. */
interface QueuedFile {
  /** Also the attachment id it uploads under, once there is an Item to send it against. */
  id: string;
  file: File;
  /** An object URL for an image's own thumbnail, or null for anything else - freed once removed, uploaded, or the form unmounts. */
  previewUrl: string | null;
}

/** One note this page has captured, as this page remembers it. */
interface Captured {
  /** The Item's id. */
  id: string;
  /** When Capture was pressed. */
  at: number;
  message: string;
  /** Which type it was given, which every capture has. */
  typeId: string;
  /** Null where it was left on *Any workspace*. */
  workspaceId: string | null;
}

/** A row of *Just captured*: still in the outbox, with its state and entry, or landed, with neither. */
type Row = Captured & { state: EntryState | null; entry: OutboxEntry | null };

/** A dropped, pasted, chosen or put-back file, as a chip in the box. */
function toQueued(file: File): QueuedFile {
  return {
    id: uuidv7(),
    file,
    previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
  };
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
    <div className="order-4 mt-3.5 flex flex-col gap-2 sm:order-none sm:mt-5 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2">
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
          : 'border-shade/10 bg-white text-ink'
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
 * where it went, and how long ago - or, while it is still on this device,
 * *Waiting to send*, or *Not sent* with the server's reason and **Put back**.
 *
 * **The type is looked up rather than remembered**, so a row renamed or
 * recoloured in the window types are managed in says so here too, without this
 * list keeping a second copy of a name that can go stale behind it.
 */
function CapturedRow({
  captured,
  types,
  workspaces,
  onPutBack,
}: {
  captured: Row;
  types: readonly ItemType[];
  workspaces: readonly Workspace[];
  /** Offered only on a row the server refused, which is one still in the outbox. */
  onPutBack: (() => void) | null;
}) {
  const type = types.find((one) => one.id === captured.typeId);
  const workspace = workspaces.find((one) => one.id === captured.workspaceId);
  const { state } = captured;

  return (
    <li className="flex flex-col gap-0.5 border-b border-shade/5 py-2 last:border-0 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2 sm:py-[7px]">
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
        {/* Where it stands, in the slot its time takes once it has landed:
            nothing about a capture still on this device is "now". */}
        {state === null ? (
          <span className="tabular-nums text-ink-faint">{howLongAgo(Date.now() - captured.at)}</span>
        ) : state.waiting ? (
          <span className="text-ink-faint">Waiting to send</span>
        ) : null}
      </span>
      {state && !state.waiting && (
        <span className="flex w-full items-center gap-2 pl-4 text-xs sm:pl-4">
          <span className="min-w-0 flex-1 text-over">Not sent: {state.notSent}</span>
          {onPutBack && (
            <button
              type="button"
              onClick={onPutBack}
              className="shrink-0 rounded-md border border-shade/10 px-2 py-0.5 text-ink-soft hover:border-accent hover:bg-accent-tint hover:text-accent-deep"
            >
              Put back
            </button>
          )}
        </span>
      )}
    </li>
  );
}
