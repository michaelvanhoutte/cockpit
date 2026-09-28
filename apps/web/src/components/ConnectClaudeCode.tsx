import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useConnectClaudeCode } from '../api/queries';

/**
 * The one-line instruction the routine is given, shown with a Copy button so
 * it can be pasted into Claude Code exactly ("Connect a workspace to Claude
 * Code", issue 569, step 2). Matches `TEST_PROMPT`
 * (apps/api/src/connectors/claude-code.ts) only by accident of both being
 * short and imperative - this is the routine's own standing instruction,
 * fired for real Items; the server's test session is a one-off, fired to
 * prove the trigger address and token before either is stored.
 */
const ROUTINE_PROMPT = 'Work the Cockpit Item described in the trigger payload, then stop.';

/**
 * The form Claude Code's own *Connect* (or an existing connection's
 * *Edit…*) opens: the three steps, and the two fields a routine's trigger is
 * proven with before anything is stored ("Connect a workspace to Claude
 * Code", issue 569).
 *
 * **Nested inside `ManageConnections`'s own window rather than replacing
 * it**, the same reason `DeleteQuestion` opens over that window instead of a
 * page of its own: the connections list stays exactly where it was once this
 * closes, whichever way it closes.
 *
 * **Never pre-filled.** Editing asks for the token again rather than
 * offering to keep it, because the server never hands a stored token back to
 * the browser to begin with (rule 3, "the token never leaves the server once
 * stored") - there is nothing here to prefill it *with*.
 *
 * **A refusal keeps the dialog open, with what was typed still in it**, the
 * same rule `NameQuestion` gives for the same reason: a token mistyped once
 * is corrected, not retyped from nothing.
 */
export function ConnectClaudeCode({
  open,
  workspaceId,
  onClose,
  onPendingChange,
  returnFocusTo,
}: {
  open: boolean;
  workspaceId: string;
  onClose: () => void;
  /**
   * Told every time this form's own submit goes from idle to in flight or
   * back, so `ManageConnections`'s own `canClose` can cover this third
   * mutation too - it lives inside this nested dialog and the outer window
   * otherwise has no way to know about it (found in review).
   */
  onPendingChange?: (pending: boolean) => void;
  returnFocusTo?: HTMLElement | null;
}) {
  const [routineUrl, setRoutineUrl] = useState('');
  const [token, setToken] = useState('');
  const connect = useConnectClaudeCode(workspaceId);

  // A form reopened on a connection already handled keeps neither the last
  // attempt's fields nor its refusal - the same reason `startDisconnecting`
  // resets `command` in `ManageConnections`.
  useEffect(() => {
    if (!open) return;
    setRoutineUrl('');
    setToken('');
    connect.reset();
    // `connect` is a fresh object from `useMutation` every render; only the
    // dialog opening should reset the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const busy = connect.isPending;

  useEffect(() => {
    onPendingChange?.(busy);
    // `onPendingChange` is `setClaudeCodeFormPending`, a `useState` setter -
    // stable across renders, so omitting it does not risk a stale closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);
  const refusal =
    connect.data && !connect.data.accepted
      ? connect.data.message
      : connect.error
        ? 'That did not reach the server. Try again.'
        : null;

  const close = () => {
    if (busy) return;
    onClose();
  };

  return (
    <Dialog.Root open={open} onOpenChange={(nowOpen) => !nowOpen && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/30" />
        <Dialog.Content
          onCloseAutoFocus={(event) => {
            if (!returnFocusTo) return;
            event.preventDefault();
            returnFocusTo.focus();
          }}
          className="fixed left-1/2 top-[calc(1rem_+_var(--edge-top))] w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 rounded-lg border border-black/10 bg-surface p-5 shadow-lg md:top-1/2 md:-translate-y-1/2"
        >
          <Dialog.Title className="text-base font-semibold">Connect Claude Code</Dialog.Title>
          <Dialog.Description className="pt-2 text-sm text-ink-soft">
            A routine that starts a Claude Code session on this workspace's items.
          </Dialog.Description>

          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!routineUrl.trim() || !token.trim()) return;
              connect.mutate(
                { routineUrl: routineUrl.trim(), token: token.trim() },
                { onSuccess: (outcome) => outcome.accepted && onClose() },
              );
            }}
            className="pt-4"
          >
            <ol className="flex flex-col gap-3 text-sm">
              <li>1. Create a routine on this workspace's repository in Claude Code.</li>
              <li>
                <p>2. Give it this prompt:</p>
                <div className="mt-1 flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded bg-black/5 px-1.5 py-0.5 font-mono text-sm text-ink-soft">
                    {ROUTINE_PROMPT}
                  </code>
                  <button
                    type="button"
                    onClick={() => void navigator.clipboard.writeText(ROUTINE_PROMPT).catch(() => {})}
                    className="shrink-0 rounded-md border border-black/10 px-2 py-1 text-sm text-ink-faint hover:border-accent hover:bg-accent-tint hover:text-accent-deep"
                  >
                    Copy
                  </button>
                </div>
              </li>
              <li>
                <p>3. Paste the routine's API trigger URL and token:</p>
                <div className="mt-1 flex flex-col gap-2">
                  <input
                    value={routineUrl}
                    onChange={(event) => setRoutineUrl(event.target.value)}
                    aria-label="Routine trigger URL"
                    placeholder="https://api.anthropic.com/v1/claude_code/routines/…/fire"
                    autoFocus
                    disabled={busy}
                    className="w-full rounded-md border border-black/10 bg-surface px-3 py-2 text-base outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft/40 disabled:opacity-50"
                  />
                  <input
                    value={token}
                    onChange={(event) => setToken(event.target.value)}
                    type="password"
                    aria-label="Routine token"
                    placeholder="Token"
                    disabled={busy}
                    className="w-full rounded-md border border-black/10 bg-surface px-3 py-2 text-base outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft/40 disabled:opacity-50"
                  />
                </div>
              </li>
            </ol>

            {refusal && (
              <p role="alert" className="pt-3 text-sm text-over">
                {refusal}
              </p>
            )}

            <div className="flex justify-end gap-2 pt-5">
              <Dialog.Close
                disabled={busy}
                className="shrink-0 rounded-md border border-black/10 px-3 py-1.5 text-sm text-ink-soft hover:bg-accent-tint hover:text-accent-deep disabled:opacity-50"
              >
                Cancel
              </Dialog.Close>
              <button
                type="submit"
                disabled={busy || !routineUrl.trim() || !token.trim()}
                className="shrink-0 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-deep disabled:opacity-50"
              >
                Connect
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
