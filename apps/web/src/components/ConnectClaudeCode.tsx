import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useQuery } from '@tanstack/react-query';
import { claudeCodeHooksSchema, claudeCodeHooksSnippet, type ClaudeCodeHooks } from '@cockpit/shared';
import { api, refusal } from '../api/client';
import { useConnectClaudeCode } from '../api/queries';

/**
 * The prompt offered for the routine, shown in full with a Copy button so it
 * can be pasted into Claude Code exactly ("Connect a workspace to Claude
 * Code", issue 569, step 3). It only defers: what a session does is the
 * message Cockpit sends, which opens with `AGENT_PREAMBLE` ("Make an agent's
 * message the whole task, whatever the routine's prompt says", issue 638).
 */
const ROUTINE_PROMPT = 'Do what the message in the trigger payload says.';

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
  connectionId,
}: {
  open: boolean;
  workspaceId: string;
  /** The connection this edits, where one is held - what the hooks in step 4 are issued for (issue 572). */
  connectionId?: string | undefined;
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
        <Dialog.Overlay className="fixed inset-0 z-floating bg-black/30" />
        <Dialog.Content
          onCloseAutoFocus={(event) => {
            if (!returnFocusTo) return;
            event.preventDefault();
            returnFocusTo.focus();
          }}
          className="fixed z-floating left-1/2 top-[calc(1rem_+_var(--edge-top))] max-h-[calc(100dvh-2rem_-_var(--edge-top))] flex w-[min(40rem,calc(100vw-2rem))] -translate-x-1/2 flex-col rounded-lg border border-black/10 bg-surface p-5 shadow-lg md:top-1/2 md:-translate-y-1/2"
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!routineUrl.trim() || !token.trim()) return;
              connect.mutate(
                { routineUrl: routineUrl.trim(), token: token.trim() },
                { onSuccess: (outcome) => outcome.accepted && onClose() },
              );
            }}
            className="flex min-h-0 flex-1 flex-col"
          >
            {/* Title, steps and a refusal scroll as one piece; Cancel and
                Connect stay below it, in view whatever the height. */}
            <div className="min-h-0 flex-1 overflow-y-auto">
              <Dialog.Title className="text-base font-semibold">Connect Claude Code</Dialog.Title>
              <Dialog.Description className="pt-2 text-sm text-ink-soft">
                A routine that starts a Claude Code session on this workspace's items.
              </Dialog.Description>
              <ol className="flex flex-col gap-3 pt-4 text-sm">
                <li>1. Create a routine on this workspace's repository in Claude Code.</li>
                <li>
                  {/* The links an agent's message carries point here, and so do
                      the hooks of step 5, and a routine's environment reaches
                      only the domains it allows ("Send an item's attachments
                      along when an agent starts", issue 573). Said once, here,
                      since it is needed before the first start. */}
                  2. Allow its environment to reach{' '}
                  <code className="rounded bg-black/5 px-1.5 py-0.5 font-mono text-sm text-ink-soft">
                    {window.location.hostname}
                  </code>
                  , so the session can read an item's attachments and say when it is waiting on you.
                </li>
                <li>
                  <p>
                    3. A routine needs a prompt, but Cockpit's message supplies the task, so give it one that defers to
                    that message:
                  </p>
                  <div className="mt-1 flex items-start gap-2">
                    <code
                      aria-label="Routine prompt"
                      className="min-w-0 flex-1 whitespace-pre-wrap break-words rounded bg-black/5 px-1.5 py-0.5 font-mono text-sm text-ink-soft"
                    >
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
                  <p>4. Paste the routine's API trigger URL and token:</p>
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
                {connectionId && <ReportingBack open={open} workspaceId={workspaceId} connectionId={connectionId} />}
              </ol>

              {refusal && (
                <p role="alert" className="pt-3 text-sm text-over">
                  {refusal}
                </p>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-4">
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

/**
 * The hooks a connection's repository needs for an item to say when Claude
 * is waiting on you ("See on the item when Claude is waiting on you", issue
 * 572). Fetched here rather than in `api/client.ts`, for the reason
 * `ManageConnections` gives for its own list: only this window asks.
 */
async function fetchHooks(workspaceId: string, sourceAccountId: string): Promise<ClaudeCodeHooks> {
  const res = await api.v1.workspaces[':workspaceId'].connections['claude-code'][':sourceAccountId'].hooks.$post({
    param: { workspaceId, sourceAccountId },
  });
  if (!res.ok) throw refusal('Claude Code hooks', res.status);
  return claudeCodeHooksSchema.parse(await res.json());
}

/**
 * Step 5, on a connection already held: the snippet for the repository's
 * `.claude/settings.json`, and when a hook last reached Cockpit - which is
 * how a repository whose hooks never arrive is told from one that is simply
 * quiet. Read afresh every time the form opens, since that last time is the
 * point. The domain the hooks post to is step 2's, allowed before connecting.
 */
function ReportingBack({
  open,
  workspaceId,
  connectionId,
}: {
  open: boolean;
  workspaceId: string;
  connectionId: string;
}) {
  const { data, error } = useQuery({
    queryKey: ['claudeCodeHooks', workspaceId, connectionId],
    queryFn: () => fetchHooks(workspaceId, connectionId),
    staleTime: 0,
    enabled: open,
  });

  return (
    <li>
      <p>5. So an item says when Claude is waiting on you, add these hooks to the repository's .claude/settings.json:</p>
      {error && !data && <p className="pt-1 text-sm text-over">The hooks could not be read. Close this and try again.</p>}
      {data && (
        <div className="mt-1 flex flex-col gap-2">
          <div className="flex items-start gap-2">
            <pre
              aria-label="Hooks for .claude/settings.json"
              className="max-h-72 min-w-0 flex-1 overflow-y-auto whitespace-pre-wrap break-all rounded bg-black/5 px-1.5 py-0.5 font-mono text-xs text-ink-soft"
            >
              {claudeCodeHooksSnippet(data)}
            </pre>
            <CopyButton text={claudeCodeHooksSnippet(data)} />
          </div>
          <p className="text-ink-faint">
            {data.lastArrivedAt
              ? `A hook last arrived ${new Date(data.lastArrivedAt).toLocaleString()}.`
              : 'No hook has arrived yet.'}
          </p>
        </div>
      )}
    </li>
  );
}

function CopyButton({ text }: { text: string }) {
  return (
    <button
      type="button"
      onClick={() => void navigator.clipboard.writeText(text).catch(() => {})}
      className="shrink-0 rounded-md border border-black/10 px-2 py-1 text-sm text-ink-faint hover:border-accent hover:bg-accent-tint hover:text-accent-deep"
    >
      Copy
    </button>
  );
}