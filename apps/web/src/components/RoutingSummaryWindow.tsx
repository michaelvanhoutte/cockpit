import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useQuery } from '@tanstack/react-query';
import { ROUTING_SUMMARY_CORRECTION_LIMIT, uuidv7 } from '@cockpit/shared';
import { snapshotQuery, useSendCommand } from '../api/queries';
import { ManageWindow } from './ManageWindow';
import { LoadFailure } from './LoadFailure';

/**
 * Where a Workspace's own sentence about where its notes belong is written
 * ("Show what the system learned, in a sentence you can correct", issue 301).
 *
 * **One text, where there were two.** A generated summary was drawn read-only
 * above this box, rewritten nightly and read back by nothing, and it is gone
 * ("Drop the nightly filing summary, keep the sentence you wrote", issue
 * 392). What is left is the half that was always doing the work: a plain
 * textarea, because it is the one thing on this screen a person actually
 * writes, and what they write outranks every pattern read out of the
 * decision history (`domain/routing-summary.ts` in `packages/shared`).
 *
 * **Per Workspace, not per account** - unlike `ManageTypes` beside it. The
 * decision history this steers is itself scoped to one Workspace
 * (`docs/routing-learning.md`, "Open decisions"), and a sentence spanning
 * several would say something about one Workspace's filing while another
 * Workspace's tab is open, crossing the privacy boundary a Workspace
 * otherwise draws (functional-definition.md, "Container hierarchy"). Moving
 * it to account scope is its own step (`docs/text-learning.md`, "Build
 * order"), and is what will rename this screen.
 */
export function RoutingSummaryWindow({
  workspaceId,
  open,
  onClose,
  returnFocusTo,
}: {
  workspaceId: string;
  open: boolean;
  onClose: () => void;
  /** The control it was opened from, which gets the focus back. */
  returnFocusTo?: HTMLElement | null | undefined;
}) {
  const { data, error, refetch } = useQuery(snapshotQuery(workspaceId));
  const send = useSendCommand();

  const routingSummary = data?.routingSummary ?? null;
  const storedCorrection = routingSummary?.correction ?? '';

  /** What is typed so far - nothing here has been sent until Save. */
  const [draft, setDraft] = useState(storedCorrection);
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  /**
   * Reset to the stored correction whenever the window opens, or when the
   * stored value itself changes under it - another tab's own Save, or this
   * one's own re-read after Save lands. Never while it is closed and nobody
   * is looking: there is nothing to protect a keystroke from then.
   *
   * **The refusal goes with it, on open** - the same rule `ManageTypes.tsx`'s
   * own form follows ("The form goes, and the refusal it was showing goes
   * with it"). This window stays mounted across a workspace switch, unlike
   * that one's nested form, so without this an error from a previous save -
   * on this Workspace or, having switched tabs, a different one entirely -
   * would still be sitting there the next time this is opened.
   */
  useEffect(() => {
    if (!open) return;
    setDraft(storedCorrection);
    setRefusal(null);
  }, [open, storedCorrection]);

  const trimmed = draft.trim();
  const dirty = trimmed !== storedCorrection;
  // Measured against the trimmed length, matching what the server actually
  // validates (`routingSummaryCorrectionSchema`, packages/shared) - trailing
  // whitespace must not refuse a save the server would accept.
  const overCap = trimmed.length > ROUTING_SUMMARY_CORRECTION_LIMIT;
  const canSave = dirty && !overCap && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setRefusal(null);
    try {
      await send({
        name: 'set_routing_summary_correction',
        payload: {
          commandId: uuidv7(),
          issuedAt: new Date().toISOString(),
          workspaceId,
          correction: trimmed,
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
      title="What Cockpit has learned"
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
            <label
              htmlFor="routing-summary-correction"
              className="text-xs font-semibold uppercase tracking-wide text-ink-faint"
            >
              Your correction
            </label>
            <textarea
              id="routing-summary-correction"
              rows={3}
              disabled={saving}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Say in a sentence where your notes should go, and Cockpit will follow it."
              className="mt-1 w-full resize-y rounded-md border border-black/10 bg-white px-3 py-2 text-sm text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft/40"
            />
            {overCap && (
              <p role="alert" className="mt-1 text-xs text-over">
                {trimmed.length - ROUTING_SUMMARY_CORRECTION_LIMIT} characters too many.
              </p>
            )}
          </div>

          {refusal && (
            <p role="alert" className="text-sm text-over">
              {refusal}
            </p>
          )}
        </div>
      )}

      {/* Save and the way out, side by side - unlike the plain `CloseWindow`
          the three list windows share, this screen has a draft that is not
          sent until Save, the same shape `RowForm.tsx`'s own footer is. */}
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
