import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useQuery } from '@tanstack/react-query';
import {
  ACCOUNT_WIDE,
  TEXT_LEARNING_GUIDANCE,
  TEXT_LEARNING_RULES_LIMIT,
  TITLE_LENGTH,
  textLearningRatioSentence,
  uuidv7,
} from '@cockpit/shared';
import type { PinnedExample } from '@cockpit/shared';
import { textLearningStatusQuery, useSendCommand } from '../api/queries';
import { DeleteQuestion } from './DeleteQuestion';
import { ManageWindow } from './ManageWindow';
import { LoadFailure } from './LoadFailure';
import { RowMenu } from './Menu';

/**
 * What Cockpit is told, and where an account says how it wants that changed
 * ("Show what Cockpit is told, and say how you want it changed", issue 398;
 * `docs/text-learning.md`, "Where you see it, and change it").
 *
 * **Account-scoped, like `ManageTypes` beside it and unlike
 * `RoutingSummaryWindow`** - how somebody writes is a property of them, not
 * of which Workspace a note landed in (`docs/text-learning.md`, "Scope: per
 * account"). Reached the same way `ManageTypes` is: a `DropdownMenu.Item` in
 * the Settings menu (`pages/Layout.tsx`), with no `params.workspaceId` gate.
 *
 * **Four things on one screen**, in the order the design calls for:
 * Cockpit's own guidance, read-only; the account's own rules; its pinned
 * examples - added, edited and deleted here ("Pin an example of how you
 * want a note written", issue 397); and how the proposals are doing. The
 * guidance is read-only on purpose - some of its lines are load-bearing for
 * the shape of the answer, and editing them breaks the feature rather than
 * restyling it. Nothing is lost by reading rather than writing it: the
 * rules box below already outranks it, so anything disagreed with is
 * contradicted in its own words instead.
 */

/** What the add/edit form on a pinned example holds - nothing here is sent until Save. */
interface PinnedExampleDraft {
  note: string;
  title: string;
  description: string;
}
const EMPTY_EXAMPLE_DRAFT: PinnedExampleDraft = { note: '', title: '', description: '' };

export function TextLearningRulesWindow({
  open,
  onClose,
  returnFocusTo,
}: {
  open: boolean;
  onClose: () => void;
  /** The control it was opened from, which gets the focus back. */
  returnFocusTo?: HTMLElement | null | undefined;
}) {
  // `enabled: open` rather than the ambient fetch `itemTypesQuery` and
  // `RoutingSummaryWindow`'s `snapshotQuery` get: unlike those, nothing else
  // in the app reads this account-wide status, and answering it costs a scan
  // over every text this account has ever been proposed - not worth paying on
  // every session for a window most sessions never open.
  const { data, error, refetch } = useQuery({ ...textLearningStatusQuery, enabled: open });
  const send = useSendCommand();

  const storedRules = data?.rules ?? '';

  /** What is typed so far - nothing here has been sent until Save. */
  const [draft, setDraft] = useState(storedRules);
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  /**
   * Reset to the stored rules whenever the window opens, or when the stored
   * value itself changes under it - another tab's own Save, or this one's
   * own re-read after Save lands. Never while it is closed and nobody is
   * looking, the same rule `RoutingSummaryWindow` follows for the same
   * reason.
   */
  useEffect(() => {
    if (!open) return;
    setDraft(storedRules);
    setRefusal(null);
  }, [open, storedRules]);

  const trimmed = draft.trim();
  const dirty = trimmed !== storedRules;
  const overCap = trimmed.length > TEXT_LEARNING_RULES_LIMIT;
  const canSave = dirty && !overCap && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setRefusal(null);
    try {
      await send({
        name: 'set_text_learning_rules',
        payload: {
          commandId: uuidv7(),
          issuedAt: new Date().toISOString(),
          workspaceId: ACCOUNT_WIDE,
          rules: trimmed,
        },
      });
    } catch (failure) {
      setRefusal(failure instanceof Error ? failure.message : 'That could not be saved');
    } finally {
      setSaving(false);
    }
  };

  const pinnedExamples = data?.pinnedExamples ?? [];

  /** The example form open on the window, if any, and which of the two things it does. */
  const [exampleForm, setExampleForm] = useState<{ mode: 'add' } | { mode: 'edit'; id: string } | null>(null);
  const [exampleDraft, setExampleDraft] = useState<PinnedExampleDraft>(EMPTY_EXAMPLE_DRAFT);
  const [exampleSaving, setExampleSaving] = useState(false);
  const [exampleRefusal, setExampleRefusal] = useState<string | null>(null);

  const [deletingExampleId, setDeletingExampleId] = useState<string | null>(null);
  const [deletingExample, setDeletingExample] = useState(false);
  const [deleteExampleRefusal, setDeleteExampleRefusal] = useState<string | null>(null);

  /**
   * The control an example form or a delete question was opened from, which
   * gets the focus back - one ref for both, since at most one of them is
   * ever open at a time (`openAddExample`/`openEditExample` always clear
   * `deletingExampleId`, `startDeletingExample` always closes the form).
   */
  const exampleActionOpenedFrom = useRef<HTMLElement | null>(null);

  /**
   * Forgets a half-typed add, a half-typed edit and an unanswered delete
   * question whenever the window (re)opens - the same rule the rules box
   * above follows for its own draft, and for the same reason: this window
   * stays mounted between openings (`pages/Layout.tsx`), so without this an
   * abandoned "Add example" draft would reopen itself, pre-filled, the next
   * time the window is opened.
   */
  useEffect(() => {
    if (!open) return;
    setExampleForm(null);
    setExampleDraft(EMPTY_EXAMPLE_DRAFT);
    setExampleRefusal(null);
    setDeletingExampleId(null);
    setDeleteExampleRefusal(null);
  }, [open]);

  /** The envelope every pinned-example change carries: an example belongs to the account, not a workspace. */
  const exampleEnvelope = () => ({
    commandId: uuidv7(),
    issuedAt: new Date().toISOString(),
    workspaceId: ACCOUNT_WIDE,
  });

  const openAddExample = (openedFrom: HTMLElement | null) => {
    setDeletingExampleId(null);
    exampleActionOpenedFrom.current = openedFrom;
    setExampleDraft(EMPTY_EXAMPLE_DRAFT);
    setExampleRefusal(null);
    setExampleForm({ mode: 'add' });
  };
  const openEditExample = (example: PinnedExample, openedFrom: HTMLElement | null) => {
    setDeletingExampleId(null);
    exampleActionOpenedFrom.current = openedFrom;
    setExampleDraft({ note: example.note, title: example.title, description: example.description ?? '' });
    setExampleRefusal(null);
    setExampleForm({ mode: 'edit', id: example.id });
  };
  const closeExampleForm = () => {
    setExampleForm(null);
    setExampleRefusal(null);
  };

  const canSaveExample =
    !exampleSaving && exampleDraft.note.trim().length > 0 && exampleDraft.title.trim().length > 0;

  const saveExample = async () => {
    if (!exampleForm || !canSaveExample) return;
    setExampleSaving(true);
    setExampleRefusal(null);
    const fields = {
      note: exampleDraft.note.trim(),
      title: exampleDraft.title.trim(),
      description: exampleDraft.description.trim(),
    };
    try {
      if (exampleForm.mode === 'add') {
        await send({
          name: 'pin_text_example',
          payload: { ...exampleEnvelope(), exampleId: uuidv7(), ...fields },
        });
      } else {
        await send({
          name: 'edit_pinned_example',
          payload: { ...exampleEnvelope(), exampleId: exampleForm.id, ...fields },
        });
      }
      closeExampleForm();
    } catch (failure) {
      setExampleRefusal(failure instanceof Error ? failure.message : 'That could not be saved');
    } finally {
      setExampleSaving(false);
    }
  };

  const startDeletingExample = (example: PinnedExample, openedFrom: HTMLElement | null) => {
    closeExampleForm();
    exampleActionOpenedFrom.current = openedFrom;
    setDeleteExampleRefusal(null);
    setDeletingExampleId(example.id);
  };
  const stopDeletingExample = () => {
    setDeletingExampleId(null);
    setDeleteExampleRefusal(null);
  };
  const confirmDeleteExample = async () => {
    if (!deletingExampleId || deletingExample) return;
    setDeletingExample(true);
    setDeleteExampleRefusal(null);
    try {
      await send({
        name: 'delete_pinned_example',
        payload: { ...exampleEnvelope(), exampleId: deletingExampleId },
      });
      setDeletingExampleId(null);
    } catch (failure) {
      setDeleteExampleRefusal(failure instanceof Error ? failure.message : 'That could not be deleted');
    } finally {
      setDeletingExample(false);
    }
  };

  const editingExample = pinnedExamples.find(
    (example) => exampleForm?.mode === 'edit' && example.id === exampleForm.id,
  );
  const deletingExampleRow = pinnedExamples.find((example) => example.id === deletingExampleId);

  return (
    <ManageWindow
      title="What Cockpit is told"
      open={open}
      onClose={onClose}
      canClose={!saving && !exampleSaving && !deletingExample}
      returnFocusTo={returnFocusTo}
    >
      {error ? (
        <LoadFailure error={error} onRetry={() => refetch()} />
      ) : (
        <div className="mt-3 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto text-sm">
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
              What Cockpit is told
            </h3>
            {/* Imported directly rather than read off the query: it never
                changes at runtime, and importing the same constant the
                prompt itself renders is what keeps the two from ever
                reading differently (`@cockpit/shared`, `TEXT_LEARNING_GUIDANCE`). */}
            <ul className="mt-1 list-disc space-y-1 pl-5 text-ink-soft">
              {TEXT_LEARNING_GUIDANCE.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>

          <div>
            <label
              htmlFor="text-learning-rules"
              className="text-xs font-semibold uppercase tracking-wide text-ink-faint"
            >
              Your rules
            </label>
            <textarea
              id="text-learning-rules"
              rows={3}
              disabled={saving}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Say how you want a title and a message written, and Cockpit will follow it ahead of everything else."
              className="mt-1 w-full resize-y rounded-md border border-black/10 bg-white px-3 py-2 text-sm text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft/40"
            />
            {overCap && (
              <p role="alert" className="mt-1 text-xs text-over">
                {trimmed.length - TEXT_LEARNING_RULES_LIMIT} characters too many.
              </p>
            )}
          </div>

          <div>
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                Pinned examples
              </h3>
              <button
                type="button"
                onClick={(event) => openAddExample(event.currentTarget)}
                className="shrink-0 text-xs font-medium text-accent hover:text-accent-deep"
              >
                Add example
              </button>
            </div>
            {pinnedExamples.length === 0 ? (
              <p className="mt-1 text-ink-faint">
                Nothing pinned yet. Add an example of a note and the title and message you would have
                written for it.
              </p>
            ) : (
              <ul className="mt-1">
                {pinnedExamples.map((example) => (
                  <li
                    key={example.id}
                    className="flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-accent-tint/40"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-ink">{example.title}</p>
                      <p className="truncate text-xs text-ink-faint">{example.note}</p>
                    </div>
                    <RowMenu
                      label={`Actions for the example "${example.title}"`}
                      entries={[
                        {
                          label: 'Edit…',
                          onSelect: (openedFrom) => openEditExample(example, openedFrom),
                        },
                        {
                          label: 'Delete',
                          destructive: true,
                          onSelect: (openedFrom) => startDeletingExample(example, openedFrom),
                        },
                      ]}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
              How it is doing
            </h3>
            <p className="mt-1 text-ink-soft">
              {data
                ? data.proposedTotal === 0
                  ? 'Nothing proposed and seen yet.'
                  : textLearningRatioSentence(data.proposedTotal, data.correctedTotal)
                : 'Loading…'}
            </p>
          </div>

          {refusal && (
            <p role="alert" className="text-sm text-over">
              {refusal}
            </p>
          )}

          {exampleForm && (
            <PinnedExampleForm
              title={exampleForm.mode === 'add' ? 'Add example' : `Edit ${editingExample?.title ?? 'example'}`}
              draft={exampleDraft}
              onDraft={setExampleDraft}
              refusal={exampleRefusal}
              saving={exampleSaving}
              canSave={canSaveExample}
              returnFocusTo={exampleActionOpenedFrom.current}
              onCancel={closeExampleForm}
              onSave={() => void saveExample()}
            />
          )}
          {deletingExampleRow && (
            <DeleteQuestion
              open
              question={`Delete the example "${deletingExampleRow.title}"?`}
              confirmLabel={`Yes, delete the example "${deletingExampleRow.title}"`}
              canConfirm={!deletingExample}
              refusal={deleteExampleRefusal}
              returnFocusTo={exampleActionOpenedFrom.current}
              onCancel={stopDeletingExample}
              onConfirm={() => void confirmDeleteExample()}
            />
          )}
        </div>
      )}

      <div className="flex justify-end gap-2 pt-5">
        <Dialog.Close
          type="button"
          disabled={saving}
          className="shrink-0 rounded-md border border-black/10 px-3 py-1.5 text-sm text-ink-soft hover:bg-accent-tint hover:text-accent-deep disabled:opacity-50"
        >
          Done
        </Dialog.Close>
        <button
          type="button"
          disabled={!canSave}
          onClick={() => void save()}
          className="milled shrink-0 rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-white hover:bg-accent-deep disabled:opacity-50"
        >
          Save
        </button>
      </div>
    </ManageWindow>
  );
}

/**
 * The form a pinned example is added or edited on: the note, its title and
 * its message together ("Pin an example of how you want a note written",
 * issue 397).
 *
 * **Its own form rather than `RowForm`.** `RowForm` carries one name and an
 * optional row of choices - a colour, a theme - which fits a type or a
 * workspace but not three free-typed texts. Nothing here is sent until
 * Save, the same rule `RowForm` follows, for the same reason: a refusal
 * keeps the draft in the form rather than losing what was typed.
 */
function PinnedExampleForm({
  title,
  draft,
  onDraft,
  refusal,
  saving,
  canSave,
  onCancel,
  onSave,
  returnFocusTo,
}: {
  title: string;
  draft: PinnedExampleDraft;
  onDraft: (draft: PinnedExampleDraft) => void;
  refusal?: string | null;
  saving: boolean;
  canSave: boolean;
  onCancel: () => void;
  onSave: () => void;
  returnFocusTo?: HTMLElement | null;
}) {
  return (
    <Dialog.Root open onOpenChange={(stillOpen) => { if (!stillOpen && !saving) onCancel(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/30" />
        <Dialog.Content
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            if (!returnFocusTo) return;
            event.preventDefault();
            returnFocusTo.focus();
          }}
          className="fixed left-1/2 top-1/2 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-black/10 bg-surface p-5 shadow-lg"
        >
          <Dialog.Title className="truncate text-base font-semibold">{title}</Dialog.Title>

          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (canSave) onSave();
            }}
          >
            <label className="mt-4 block text-xs font-semibold uppercase tracking-wide text-ink-faint">
              Note
              <textarea
                autoFocus
                rows={2}
                disabled={saving}
                value={draft.note}
                onChange={(event) => onDraft({ ...draft, note: event.target.value })}
                aria-label="The captured note this example is for"
                className="mt-1 w-full resize-y rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft/40"
              />
            </label>

            <label className="mt-4 block text-xs font-semibold uppercase tracking-wide text-ink-faint">
              Title
              <input
                disabled={saving}
                value={draft.title}
                onChange={(event) => onDraft({ ...draft, title: event.target.value })}
                aria-label="The title you would have written for this note"
                maxLength={TITLE_LENGTH}
                className="mt-1 w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft/40"
              />
            </label>

            <label className="mt-4 block text-xs font-semibold uppercase tracking-wide text-ink-faint">
              Message (optional)
              <textarea
                rows={3}
                disabled={saving}
                value={draft.description}
                onChange={(event) => onDraft({ ...draft, description: event.target.value })}
                aria-label="The message you would have written for this note"
                className="mt-1 w-full resize-y rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft/40"
              />
            </label>

            {refusal && (
              <p role="alert" className="pt-3 text-sm text-over">
                {refusal}
              </p>
            )}

            <div className="flex justify-end gap-2 pt-5">
              <Dialog.Close
                type="button"
                disabled={saving}
                className="shrink-0 rounded-md border border-black/10 px-3 py-1.5 text-sm text-ink-soft hover:bg-accent-tint hover:text-accent-deep disabled:opacity-50"
              >
                Cancel
              </Dialog.Close>
              <button
                type="submit"
                disabled={!canSave}
                className="milled shrink-0 rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-white hover:bg-accent-deep disabled:opacity-50"
              >
                Save
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
