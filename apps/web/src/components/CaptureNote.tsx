import { Suspense, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { plainWords, uuidv7, type Priority, type Workspace, type WorkspaceSnapshot } from '@cockpit/shared';
import { FileOnLine, type FiledOn } from './FileOnLine';
import { CommandRefused, uploadAttachment } from '../api/client';
import { useSendCommand, workspacesQuery } from '../api/queries';
import { checkAttachmentFiles, formatFileSize, takesFiles } from '../attachmentQueue';
import { browserStore, workspaceToCaptureFrom } from '../lastVisited';
import { useCapture } from '../capture';
import { stateOf, whatGoesBack, type OutboxEntry } from '../captureOutbox';
import { fileOf, useOutbox, useWaitingCaptures } from '../captureOutboxSender';
import { useDockedItem } from '../itemForm';
import type { Arrived } from '../shares';
import { LazyRichDescription, NewerVersionIfStale, WhateverTheEditorDoes } from '../description/lazyEditor';
import { DueChips, LIT_BUTTON, PriorityFlags, QUIET_BUTTON, STRIP_BUTTON } from './StripChoices';
import { appendPhrase } from '../dictation';
import { clock, useRecordedDictation, type RecordedDictation, type StartRecording } from '../recording';
import { transcriptionOfferedQuery } from '../api/transcription';
import { useKeptRecordings } from '../keptRecordings';

/** Said where that recording could not be kept under the strip, so it stays listed to put back again. */
export const RECORDING_NOT_PUT_BACK = 'The recording could not be kept here to retry, so it stays listed.';

/**
 * The Capture form itself: the note, where it goes as one
 * more row of chips, and under the Capture button one line saying what was
 * captured, with Undo ("Capture Page", artboards 2a and 2c; issue 1104).
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
 * that write is done, and the outbox sends it. What is still waiting or refused
 * is one line drawn from the outbox, so it survives a reload. Only where the outbox
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
  startsOn,
  arrived,
  onPutOn,
  onCaptured,
  dictating,
}: {
  startsIn: string | null;
  /** A Panel *File on* starts holding, and so its Workspace for Where: what a Panel's + opens (issue 1105). */
  startsOn?: FiledOn | null | undefined;
  /** What the share sheet handed over, claimed by the page: put on the note once, as if typed and dropped here. */
  arrived?: Arrived | null | undefined;
  /** Said once `arrived` is on the note, so the page can stop offering it to a form drawn again. */
  onPutOn?: (() => void) | undefined;
  /** Said when a capture is made on this form. */
  onCaptured?: (() => void) | undefined;
  /**
   * What dictation records with and transcribes with: the browser's recorder and
   * the Worker, unless a test hands in fakes. `transcriber` says whether the
   * Worker can transcribe; left out, the page asks `/health`.
   */
  dictating?:
    | {
        record?: StartRecording | null;
        transcribe?: (recording: Blob) => Promise<string>;
        transcriber?: boolean;
        limitSeconds?: number;
      }
    | undefined;
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

  const [message, setMessage] = useState('');
  /**
   * The note as it stands this instant, for the two things that arrive between
   * renders: the words of a dictation, which land after whatever was typed while
   * they were being transcribed ("Dictate in Write with Whisper", issue 1041),
   * and Capture pressed while they are still on their way.
   */
  const noteNow = useRef(message);
  noteNow.current = message;
  const changeNote = (next: string) => {
    noteNow.current = next;
    setMessage(next);
  };
  /** Whether the Worker can transcribe at all; the mic is drawn only where it can. */
  const transcribable = useQuery({
    ...transcriptionOfferedQuery,
    enabled: dictating?.transcriber === undefined,
  });
  const keptRecordings = useKeptRecordings();
  const dictation = useRecordedDictation({
    ...dictating,
    // A recording whose words do not come back waits on this device, with Retry
    // ("Keep a recording Write could not transcribe, with Retry", issue 1044).
    keeping: keptRecordings,
    transcriber: dictating?.transcriber ?? transcribable.data ?? false,
    onWords: (words) => changeNote(appendPhrase(noteNow.current, words)),
  });
  const shown = message;
  /**
   * Whether the note is written in the formatted editor ("Switch the Capture
   * note to formatted", issue 758). Always plain on opening, and kept through
   * captures until the form closes: the editor is a download, and a note that
   * is usually a sentence should not pay for it.
   */
  const [formatted, setFormatted] = useState(false);
  /** The editor's file or its drawing failed: the note stays plain, and says so. */
  const [formattingFailed, setFormattingFailed] = useState(false);
  /**
   * Milkdown owns its document once it is made, so a note changed from outside
   * the editor - a dictated phrase, the box emptying after a capture, Put back -
   * is shown by building it again. `fromEditor` is the last text the editor
   * itself reported or was given, which is how its own keystrokes are told
   * apart from those.
   */
  const [generation, setGeneration] = useState(0);
  const fromEditor = useRef(shown);
  /**
   * The keyboard stays in the note across a switch, and across the editor being
   * built again, as neither is a reason to click into it again. The plain box is
   * there at once; the editor is looked for until it has been drawn.
   */
  const refocus = useRef(false);
  const theNote = () =>
    form.current?.querySelector<HTMLElement>('textarea:not([readonly]), [role="textbox"][contenteditable="true"]');
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    let tries = 0;
    const timer = setInterval(() => {
      const note = theNote();
      if (note || ++tries > 40) {
        clearInterval(timer);
        note?.focus();
      }
    }, 50);
    return () => clearInterval(timer);
  }, [formatted, generation]);
  useEffect(() => {
    // Only the editor needs building again: the plain box shows `shown` as it is.
    if (!formatted || shown === fromEditor.current) return;
    fromEditor.current = shown;
    // Building it again takes the cursor with the old one, if it was in it.
    if (form.current?.querySelector('[role="textbox"][contenteditable]')?.contains(document.activeElement)) {
      refocus.current = true;
    }
    setGeneration((was) => was + 1);
  }, [shown, formatted]);
  /** Which workspace it belongs to, or null for *Any workspace*. */
  const [where, setWhere] = useState<string | null>(startsOn?.workspaceId ?? startsIn);
  const [refused, setRefused] = useState<string | null>(null);
  /**
   * What the strip inside the box has chosen ("Set a priority and a due date
   * while capturing", issue 611): neither until pressed, and neither again once
   * a capture has been kept - unlike Where, which carries over, because
   * a deadline belongs to the one note it was set for. A refused capture puts
   * both back with the note.
   *
   * The due date is the day alone: the shortcuts are always three different
   * days, so the lit one is read off the day however it was reached.
   */
  const [priority, setPriority] = useState<Priority | null>(null);
  const [due, setDue] = useState<string | null>(null);
  /**
   * The Panels *File on* has chosen ("File a note on Panels from Capture,
   * skipping the Inbox", issue 1101). Empty is the Inbox. All of one Workspace,
   * which the first one picked settles. Like the strip, empty again once a
   * capture is kept, and put back with a refused one.
   */
  const [filed, setFiled] = useState<FiledOn[]>(startsOn ? [startsOn] : []);
  /**
   * The capture just made, until the next one or the form closes: the line
   * beside the button and the draft Undo puts back. In this form's memory
   * alone, so a reload has neither (issue 1104).
   */
  const [last, setLast] = useState<Captured | null>(null);
  /** Undo is working on it: pressed once, the line stops offering it. */
  const [undoing, setUndoing] = useState(false);
  const undone = useRef(new Set<string>());
  const send = useSendCommand();
  /** The refused captures put back while this form was open, whose line no longer offers it. */
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
  // What the page asked to be told, read when it happens rather than when drawn.
  const saidNow = useRef({ onPutOn, onCaptured });
  saidNow.current = { onPutOn, onCaptured };
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
   * What was shared into Cockpit ("Share photos, files and links into Cockpit
   * from Android's share sheet", issue 789): files wait as chips through the
   * same check a dropped file gets, words go after whatever is already in the
   * note. Once per mount - a strict-mode second run must not add it again; the
   * page keeps the claim until a capture is made, so a form drawn again before
   * that (Write, Car, Write) has it back.
   */
  const putOn = useRef<Arrived | null>(null);
  useEffect(() => {
    if (!arrived || putOn.current === arrived) return;
    putOn.current = arrived;
    if (arrived.message) setMessage((was) => (was.trim() ? `${was}\n${arrived.message}` : arrived.message));
    if (arrived.files.length > 0) queueFiles(arrived.files);
    saidNow.current.onPutOn?.();
  }, [arrived]);

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
    // Back in the box already: Undo on the same capture would put it there twice.
    setLast((was) => (was?.id === entry.id ? null : was));
    const back = whatGoesBack(entry);
    if (back.recording) {
      // A spoken note refused before its words came back: its recording is
      // kept under the strip with Retry before the entry goes, so it is never
      // in neither (issue 1045).
      const { bytes, type, seconds } = back.recording;
      try {
        await keptRecordings.keep(new Blob([bytes], { type }), seconds, entry.id);
      } catch {
        putBackHere.current.delete(entry.id);
        setPutBack((was) => {
          const next = new Set(was);
          next.delete(entry.id);
          return next;
        });
        setRefused(RECORDING_NOT_PUT_BACK);
        return;
      }
    }
    if (back.message !== null) {
      const note = back.message;
      setMessage((was) => (was.trim() ? `${was}\n${note}` : note));
      setWhere(entry.decided ? entry.workspaceId : null);
      // Back with the note they were set for, unless something has been chosen since.
      if (entry.priority) setPriority((was) => was ?? entry.priority ?? null);
      if (entry.dueDate) setDue((was) => was ?? entry.dueDate!);
      if (entry.panelIds && entry.panelIds.length > 0) {
        const held = queryClient.getQueryData<WorkspaceSnapshot>(['snapshot', entry.workspaceId]);
        const back = entry.panelIds.map((panelId) => ({
          panelId,
          name: held?.panels?.find((panel) => panel.id === panelId)?.name ?? 'A Panel',
          workspaceId: entry.workspaceId,
        }));
        setFiled((was) => (was.length > 0 ? was : back));
      }
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

  /** A draft back in the box: after what is already there, and not over a choice made since. */
  const restore = (draft: Captured) => {
    setMessage((was) => (was.trim() ? `${was}\n${draft.message}` : draft.message));
    setWhere(draft.where);
    if (draft.priority) setPriority((was) => was ?? draft.priority);
    if (draft.due) setDue((was) => was ?? draft.due);
    if (draft.filed.length > 0) setFiled((was) => (was.length > 0 ? was : draft.filed));
    setQueued((was) => [...was, ...draft.files.map(toQueued)]);
    setRefused(null);
  };

  /**
   * **Undo** takes the capture back wherever it is, then puts it in the box
   * (decision 6 of issue 1100): the outbox deletes an entry still unsent, waits
   * for one being sent, and an Item that reached the server is dismissed. The
   * box is filled only once that has worked, so a failed Undo loses nothing and
   * can be pressed again; once an Item is taken back it is never dismissed twice.
   */
  const undo = async () => {
    if (!last || undoing || undone.current.has(last.id)) return;
    const back = last;
    undone.current.add(back.id);
    setUndoing(true);
    let unsure = false;
    try {
      const took = await outbox.takeBack(back.id);
      if (took !== 'unsent') {
        try {
          await send({
            name: 'set_dismissed',
            payload: {
              commandId: uuidv7(),
              issuedAt: new Date().toISOString(),
              workspaceId: back.workspaceId,
              itemId: back.id,
              dismissed: true,
            },
          });
        } catch (failure) {
          // A send that got no answer may never have landed, so there may be nothing to dismiss.
          if (took === 'sent') throw failure;
          // Not answered at all, so the Item may be on the server undismissed: say so.
          unsure = !(failure instanceof CommandRefused);
        }
      }
    } catch (failure) {
      undone.current.delete(back.id);
      setUndoing(false);
      setRefused(failure instanceof CommandRefused ? failure.message : UNDO_FAILED);
      return;
    }
    restore(back);
    if (unsure) setRefused(UNDO_MAYBE_SENT);
    setLast((was) => (was?.id === back.id ? null : was));
    setUndoing(false);
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
   * Where it belongs, as against which chip was pressed: a workspace deleted in
   * another tab takes its chip off this row, and what was chosen then falls
   * back to *Any workspace* rather than to a capture the server will refuse.
   * The screen and the capture agree either way.
   */
  const belongsTo = workspaces.some((one) => one.id === where) ? where : null;

  /** Capture was pressed and is waiting on words still being recorded or transcribed. */
  const waitingOnWords = useRef(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Pressed mid-dictation: the recording ends and the press waits for its
    // words, which then join the note as they would have. Where they cannot be
    // had, nothing is captured and the line under the strip says why, so that
    // speech is never dropped without a word.
    if (dictation.busy) {
      if (waitingOnWords.current) return;
      waitingOnWords.current = true;
      const heard = await dictation.finish().finally(() => {
        waitingOnWords.current = false;
      });
      if (!heard) return;
    }
    const trimmed = noteNow.current.trim();
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
    const filedAtSubmit = filed;
    // Only Panels of the Workspace it is captured against: a deleted
    // Workspace's would be skipped by the server anyway.
    const panelIds = filedAtSubmit.filter((one) => one.workspaceId === targetWorkspace).map((one) => one.panelId);
    const what = {
      message: trimmed,
      // The workspace chosen, or the one this was captured from - and the
      // difference between the two is the whole of `decided`.
      workspaceId: targetWorkspace,
      decided: belongsTo !== null,
      ...(priorityAtSubmit ? { priority: priorityAtSubmit } : {}),
      ...(dueAtSubmit ? { dueDate: dueAtSubmit } : {}),
      ...(panelIds.length > 0 ? { panelIds } : {}),
    };
    // What Undo puts back, and what the line says it was filed on.
    const captured = (itemId: string): Captured => ({
      id: itemId,
      message: trimmed,
      workspaceId: targetWorkspace,
      where: belongsTo,
      priority: priorityAtSubmit,
      due: dueAtSubmit,
      filed: panelIds.length > 0 ? filedAtSubmit.filter((one) => one.workspaceId === targetWorkspace) : [],
      files: queuedAtSubmit.map((one) => one.file),
    });
    // Empties the box of what was captured and nothing typed or dropped since.
    const emptied = () => {
      setMessage((was) => (was.trim() === trimmed ? '' : was));
      setPriority((was) => (was === priorityAtSubmit ? null : was));
      setDue((was) => (was === dueAtSubmit ? null : was));
      setFiled((was) => (was === filedAtSubmit ? [] : was));
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
    // Said as it is pressed, not as it lands: the share has done its work then,
    // and another tab's or an earlier capture's landing is not this one.
    saidNow.current.onCaptured?.();
    void outbox
      .add({ ...what, id, files: queuedAtSubmit.map(({ id: fileId, file }) => ({ id: fileId, file })) })
      .then(
        () => {
          // Only now, with the note kept: a write that never finished leaves it in the box.
          for (const file of queuedAtSubmit) if (file.previewUrl) URL.revokeObjectURL(file.previewUrl);
          emptied();
          setLast(captured(id));
          setRefused(null);
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
        captured: (itemId) => {
          setLast(captured(itemId));
          void uploadQueued(queuedAtSubmit, itemId, targetWorkspace);
        },
        refused: (why) => {
          setMessage(trimmed);
          setPriority((was) => was ?? priorityAtSubmit);
          setDue((was) => was ?? dueAtSubmit);
          setFiled((was) => (was.length > 0 ? was : filedAtSubmit));
          setQueued((was) => [...queuedAtSubmit, ...was]);
          setRefused(why);
        },
      });
    }
  };

  /**
   * What the outbox still holds for you, one line each and only while there is
   * one: captures waiting to send, and captures the server refused, whose
   * **Put back** returns them to the box.
   */
  const waitingToSend = waiting.filter((entry) => stateOf(entry).waiting);
  const notSent = waiting.filter((entry) => !stateOf(entry).waiting);
  const putBackAll = () => {
    for (const entry of notSent) if (!putBackRows.has(entry.id)) void putBack(entry);
  };

  /** The plain box, which also stands in while the editor is on its way. */
  const plainBox = (readOnly: boolean) => (
    <textarea
      value={shown}
      onChange={(e) => changeNote(e.target.value)}
      placeholder="What is on your mind?"
      aria-label="What is on your mind?"
      autoFocus={!readOnly}
      readOnly={readOnly}
      rows={4}
      className="w-full flex-1 resize-none rounded-md bg-transparent p-3 text-base leading-[1.5] text-ink outline-none sm:px-5 sm:py-[18px]"
    />
  );

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
      onDropCapture={(event) => {
        if (!takesFiles(event)) return;
        event.preventDefault();
        setFilesOver(false);
        if (event.dataTransfer.files.length > 0) queueFiles(Array.from(event.dataTransfer.files));
      }}
      // Pasted anywhere on the form, including with the cursor in the message
      // box, and taken in the capture phase: a file copied with its HTML (an
      // image copied off a web page) is queued here and the formatted editor,
      // which skips an event already handled, never also inserts it. A paste
      // of text only returns before touching the event.
      onPasteCapture={(event) => {
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
          grow into and the handle is one more thing under a thumb. The handle
          is on the box rather than the field: a dragged height is an inline
          `height`, which the field's `flex-1` (a basis of zero) overrides, so
          a handle on the field moved and changed nothing. The box does not
          shrink, so a height past what the window holds scrolls the window
          instead of being squeezed back. */}
      {/* The note and, along its bottom edge, the strip that sets a priority
          and a due date: one box rather than a row of its own, which took too
          much room. The border and the focus ring belong to the box, so the
          strip reads as inside the note rather than under it. */}
      <div className="order-1 mt-2.5 flex w-full flex-col rounded-md border border-shade/10 bg-field shadow-field focus-within:border-accent focus-within:ring-2 focus-within:ring-accent-soft/40 sm:order-none sm:mt-4 sm:min-h-56 sm:shrink-0 sm:resize-y sm:overflow-auto">
        {formatted ? (
          <WhateverTheEditorDoes
            onFailure={() => {
              setFormatted(false);
              setFormattingFailed(true);
            }}
          >
            {/* On a phone the box has no height of its own to give, so the
                editor is as tall as the plain box (120px) under its own toolbar
                (33px); at a desk the box's `min-h-56` and its resize handle
                decide, and this fills them. */}
            <div
              className="flex min-h-[9.5rem] flex-1 flex-col sm:min-h-0"
              // The editor is only as tall as its text, so the rest of the box
              // is empty space that should still take the cursor, as the plain
              // box's blank lines do.
              onMouseDown={(e) => {
                if ((e.target as HTMLElement).closest('[contenteditable], button, input, [role="toolbar"]')) return;
                e.preventDefault();
                theNote()?.focus();
              }}
            >
              <Suspense fallback={plainBox(true)}>
                <LazyRichDescription
                  key={generation}
                  initial={shown}
                  label="What is on your mind?"
                  onChange={(markdown) => {
                    fromEditor.current = markdown;
                    changeNote(markdown);
                  }}
                  editable={!busy}
                  fill
                />
              </Suspense>
            </div>
          </WhateverTheEditorDoes>
        ) : (
          plainBox(false)
        )}
        <PriorityAndDue
          priority={priority}
          onPriority={setPriority}
          due={due}
          onDue={setDue}
          disabled={busy}
          dictation={dictation}
          formatted={formatted}
          onFormatted={() => {
            // Opening the editor on the note as it stands, which is not a change to tell it from.
            fromEditor.current = shown;
            refocus.current = true;
            setFormatted((was) => !was);
          }}
          canFormat={!formattingFailed}
        />
      </div>
      {formattingFailed && (
        <p role="alert" className="order-1 pt-1 text-sm text-over-ink sm:order-none">
          Formatting could not be loaded. The note is still here, as Markdown, and still captures.{' '}
          <NewerVersionIfStale />
        </p>
      )}

      {/* The Files line: chips for what is queued, + Add, and the other two
          ways in, shown whether or not anything is queued so that drop, paste
          and a picker are all named before anyone has tried one. */}
      <div
        role="group"
        aria-label="Files"
        className={`order-1 mt-2 flex flex-wrap items-center gap-1.5 rounded-md border border-dashed px-3 py-2 sm:order-none ${
          filesOver ? 'border-accent bg-accent-tint' : 'border-shade/10'
        }`}
      >
        <span
          aria-hidden="true"
          className="text-[11px] font-semibold tracking-[0.11em] text-ink-faint uppercase sm:w-[74px] sm:shrink-0 sm:text-xs"
        >
          Files
        </span>
        {queued.map((file) => (
          <div
            key={file.id}
            className="flex items-center gap-2 rounded-md border border-shade/10 bg-field px-3 py-2 text-sm"
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
        <button
          type="button"
          onClick={() => attachmentInputRef.current?.click()}
          className="rounded-md border border-shade/10 px-3 py-1.5 text-sm text-ink-soft hover:border-accent hover:bg-accent-tint disabled:opacity-50"
        >
          + Add
        </button>
        <span className="text-sm text-ink-faint">
          or drop<span className="hidden sm:inline">, or {PASTE_KEY}</span>
        </span>
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
        <p role="alert" className="order-1 pt-1 text-sm text-over-ink sm:order-none">
          {queueError}
        </p>
      )}

      <FileOnLine
        where={belongsTo}
        from={from ?? null}
        workspaces={workspaces}
        filed={filed}
        disabled={busy}
        onAdd={(option) => {
          // The first Panel picked under Any workspace settles the Workspace,
          // and the search narrows to it (issue 1101).
          setWhere(option.workspaceId);
          setFiled((was) =>
            was.some((one) => one.panelId === option.panelId)
              ? was
              : [...was.filter((one) => one.workspaceId === option.workspaceId), { panelId: option.panelId, name: option.name, workspaceId: option.workspaceId }],
          );
        }}
        onRemove={(panelId) => setFiled((was) => was.filter((one) => one.panelId !== panelId))}
      />

      <Choice label="Where" optional>
        {/* First and selected to start with: the whole point of capturing
            here is not having to answer this yet. */}
        <Chip
          name="Any workspace"
          chosen={belongsTo === null}
          onChoose={() => {
            // Panels settle a Workspace, so none can stay once it is left open.
            setFiled([]);
            setWhere(null);
          }}
        />
        {workspaces.map((workspace: Workspace) => (
          <Chip
            key={workspace.id}
            name={workspace.name}
            dot={workspace.color}
            chosen={belongsTo === workspace.id}
            onChoose={() => {
              // Panels are of one Workspace: another's do not follow the choice.
              setFiled((was) => was.filter((one) => one.workspaceId === workspace.id));
              setWhere(workspace.id);
            }}
          />
        ))}
        <span className="hidden text-xs text-ink-faint sm:inline">
          Leave it on Any workspace and it waits in every Inbox.
        </span>
      </Choice>

      {/* Directly under the note on a phone, so it stays above the on-screen
          keyboard and the browser's toolbars; below the Where row, beside the
          note's own hint, at a desk. */}
      <div className="order-2 mt-3 flex flex-wrap items-center gap-x-3.5 gap-y-2 sm:order-none sm:mt-[22px]">
        <button
          type="submit"
          disabled={busy}
          className="milled min-h-13 w-full rounded-md bg-accent text-[17px] font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50 sm:min-h-0 sm:w-auto sm:flex-none sm:rounded-md sm:px-[22px] sm:py-[11px] sm:text-[15px]"
        >
          Capture
        </button>
        {last ? (
          <p role="status" className="flex min-w-0 max-w-full items-center gap-2 text-sm text-ink-soft">
            <span className="min-w-0 truncate">
              Captured “{plainWords(last.message)}” → {last.filed.length > 0 ? last.filed.map((one) => one.name).join(', ') : 'Inbox'}
            </span>
            <button
              type="button"
              disabled={undoing}
              onClick={() => void undo()}
              className="shrink-0 rounded-md border border-shade/10 px-2 py-0.5 text-sm text-ink-soft hover:border-accent hover:bg-accent-tint hover:text-accent-deep disabled:opacity-50"
            >
              Undo
            </button>
          </p>
        ) : (
          <span className="hidden text-[13px] text-ink-faint sm:inline">
            {SHORTCUT} · the box empties and the cursor stays put
          </span>
        )}
      </div>

      {refused && (
        <p role="alert" className="order-3 pt-2 text-sm text-over-ink sm:order-none">
          {refused}
        </p>
      )}

      {/* Only while there is one: a heading over nothing says you have done nothing. */}
      {(waitingToSend.length > 0 || notSent.length > 0) && (
        <div className="order-5 mt-[18px] flex flex-col gap-1 border-t border-shade/8 pt-3 text-sm text-ink-soft sm:order-none sm:mt-auto">
          {waitingToSend.length > 0 && <p role="status">{waitingToSend.length} waiting to send</p>}
          {notSent.length > 0 && (
            <p className="flex flex-wrap items-center gap-2 text-over-ink">
              <span>{notSent.length} not sent</span>
              {notSent.some((entry) => !putBackRows.has(entry.id)) && (
                <>
                  <span aria-hidden="true">·</span>
                  <button
                    type="button"
                    onClick={putBackAll}
                    className="shrink-0 rounded-md border border-shade/10 px-2 py-0.5 text-ink-soft hover:border-accent hover:bg-accent-tint hover:text-accent-deep"
                  >
                    Put back
                  </button>
                </>
              )}
              <span className="w-full text-xs">
                {notSent.flatMap((entry) => { const state = stateOf(entry); return state.waiting ? [] : [state.notSent]; }).join(' ')}
              </span>
            </p>
          )}
        </div>
      )}
    </form>
  );
}

/** What is said where Undo could not take the capture back. */
export const UNDO_FAILED = 'That could not be undone. Try again.';

/** And where the send never got an answer, so the note may be in the Inbox as well as back in the box. */
export const UNDO_MAYBE_SENT = 'Back in the box, but it may already have reached the Inbox - check there first.';

/**
 * And what it says when there is no workspace to capture into at all. Named
 * where one is made, rather than inviting a retry that cannot come good.
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
  formatted,
  onFormatted,
  canFormat,
}: {
  priority: Priority | null;
  onPriority: (priority: Priority | null) => void;
  due: string | null;
  onDue: (due: string | null) => void;
  disabled: boolean;
  dictation: RecordedDictation;
  formatted: boolean;
  onFormatted: () => void;
  /** False once the editor has failed to load, which asking again would not mend. */
  canFormat: boolean;
}) {
  return (
    <>
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-3 pb-2">
      <PriorityFlags priority={priority} onPriority={onPriority} disabled={disabled} />

      {/* On a phone the date shortcuts are the strip's top row and the flags,
          Aa and the mic the bottom one; at a desk it is one row, flags first. */}
      <DueChips due={due} onDue={onDue} disabled={disabled} className="order-first w-full sm:order-none sm:w-auto" />

      {/* Flattened (`contents`), so that the mic's status below can wrap onto
          a row of its own on a phone and sit beside the mic at a desk. */}
      <div className="contents">
        <button
          type="button"
          disabled={disabled || !canFormat}
          aria-pressed={formatted}
          aria-label="Format the note"
          title={formatted ? 'Back to plain text' : 'Format the note'}
          onClick={onFormatted}
          className={`${STRIP_BUTTON} ml-auto w-9 font-serif sm:w-7 ${formatted ? LIT_BUTTON : QUIET_BUTTON}`}
        >
          Aa
        </button>
        {dictation.available && <Dictate dictation={dictation} disabled={disabled} />}
      </div>
    </div>
    {dictation.error && (
      <p role="alert" className="px-3 pb-2 text-sm text-over-ink">
        {dictation.error}
      </p>
    )}
    {dictation.notice && !dictation.error && (
      <p role="status" className="px-3 pb-2 text-sm text-ink-soft">
        {dictation.notice}
      </p>
    )}
    {/* Each recording kept for want of its words, oldest first, with Retry
        ("Keep a recording Write could not transcribe, with Retry", issue
        1044): drawn only while one waits, and whether or not the mic is, since
        what is kept is yours either way. */}
    {dictation.waiting.length > 0 && (
      <div role="group" aria-label="Not yet transcribed" className="flex flex-col gap-1 px-3 pb-2">
        {dictation.waiting.map((one) => (
          <div key={one.id} className="flex items-center gap-2 text-sm">
            <span className="min-w-0 flex-1 text-ink-soft">
              A recording of {clock(one.seconds)}, not yet transcribed
            </span>
            {one.retrying ? (
              <span className="text-xs text-ink-faint">Transcribing…</span>
            ) : (
              <button
                type="button"
                onClick={() => dictation.retry(one.id)}
                className={`${STRIP_BUTTON} ${QUIET_BUTTON}`}
              >
                Retry
              </button>
            )}
          </div>
        ))}
      </div>
    )}
    </>
  );
}

/**
 * The mic at the right end of the strip, drawn only where the browser can record
 * and the page has a transcriber. It is filled and pulsing once the recorder has
 * started, with the time recorded beside it; on stop it gives way to
 * *Transcribing…* until the words are in the note ("Dictate in Write with
 * Whisper", issue 1041). There is no language to choose: Whisper hears which.
 */
function Dictate({ dictation, disabled }: { dictation: RecordedDictation; disabled: boolean }) {
  const { listening, transcribing } = dictation;
  return (
    <div role="group" aria-label="Dictation" className="contents">
      {/* The one live region. Under the buttons on a phone, so they never move
          while recording; beside the mic at a desk. */}
      <span
        aria-live="polite"
        className={
          listening || transcribing
            ? 'order-last w-full text-sm tabular-nums text-ink-soft sm:order-none sm:-ml-0.5 sm:w-auto sm:text-xs sm:text-ink-faint'
            : 'sr-only'
        }
      >
        {listening ? `Listening · ${clock(dictation.seconds)}` : transcribing ? 'Transcribing…' : ''}
      </span>
      <button
        type="button"
        onClick={dictation.toggle}
        disabled={(disabled && !listening) || transcribing}
        aria-pressed={listening}
        aria-label="Dictate"
        title={listening ? 'Stop dictating' : 'Dictate the note'}
        className={`${STRIP_BUTTON} -ml-0.5 w-9 sm:w-7 ${
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

/** The capture just made, as this form remembers it: the line's words, and the draft Undo puts back. */
interface Captured {
  /** The Item's id. */
  id: string;
  message: string;
  /** The workspace it was captured against. */
  workspaceId: string;
  /** Where was chosen: null for *Any workspace*. */
  where: string | null;
  priority: Priority | null;
  due: string | null;
  filed: FiledOn[];
  /** The files it was captured with, to queue again. */
  files: File[];
}

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
 * beside a wrapping row of chips leaves no room for the chips.
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
    <div className="order-4 mt-3 flex flex-col gap-1.5 sm:order-none sm:flex-row sm:flex-wrap sm:items-center sm:gap-2">
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
        className="flex min-w-0 flex-wrap items-center gap-1.5 sm:flex-1"
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
      /* 36px high on a phone and as small as the Due shortcuts at a desk: a
         chip is one of a row of targets under a thumb there, and one of a row
         of words beside a pointer here. */
      className={`inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm sm:min-h-0 sm:px-2.5 sm:py-[3px] sm:text-[13px] ${
        chosen
          ? 'border-accent bg-accent-tint font-medium text-accent-deep'
          : 'border-shade/10 bg-field text-ink'
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
