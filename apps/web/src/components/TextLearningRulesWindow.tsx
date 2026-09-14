import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useQuery } from '@tanstack/react-query';
import {
  ACCOUNT_WIDE,
  TEXT_LEARNING_GUIDANCE,
  TEXT_LEARNING_RULES_LIMIT,
  textLearningRatioSentence,
  uuidv7,
} from '@cockpit/shared';
import { textLearningStatusQuery, useSendCommand } from '../api/queries';
import { ManageWindow } from './ManageWindow';
import { LoadFailure } from './LoadFailure';

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
 * **Three things on one screen**, in the order the design calls for:
 * Cockpit's own guidance, read-only; the account's own rules, the one thing
 * here anybody writes; and how the proposals are doing. The guidance is
 * read-only on purpose - some of its lines are load-bearing for the shape of
 * the answer, and editing them breaks the feature rather than restyling it.
 * Nothing is lost by reading rather than writing it: the rules box below
 * already outranks it, so anything disagreed with is contradicted in its own
 * words instead.
 */
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

  return (
    <ManageWindow
      title="What Cockpit is told"
      open={open}
      onClose={onClose}
      canClose={!saving}
      returnFocusTo={returnFocusTo}
    >
      {error ? (
        <LoadFailure error={error} onRetry={() => refetch()} />
      ) : (
        <div className="mt-3 flex flex-col gap-4 text-sm">
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
