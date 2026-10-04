import * as Dialog from '@radix-ui/react-dialog';

/**
 * Connecting Gmail is a navigation, like Teams': the browser leaves for
 * Google and comes back to `/w/<workspaceId>?connections=gmail-connected|refused`.
 */
function connectGmailPath(workspaceId: string): string {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}/connections/gmail/connect`;
}

/**
 * The step before Google ("Connect a Gmail account to a workspace, and
 * disconnect it", issue 724): what to do in Gmail first, what Google is about
 * to warn about and ask, and what a labelled conversation becomes - said here
 * because the warning reads like something gone wrong to anybody not told.
 *
 * **Nested over `ManageConnections`'s own window**, as `ConnectClaudeCode` is,
 * so Cancel leaves the connections list exactly where it was.
 */
export function ConnectGmail({
  open,
  workspaceId,
  workspaceName,
  onClose,
  returnFocusTo,
}: {
  open: boolean;
  workspaceId: string;
  workspaceName: string;
  onClose: () => void;
  returnFocusTo?: HTMLElement | null;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(nowOpen) => !nowOpen && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/30" />
        <Dialog.Content
          onCloseAutoFocus={(event) => {
            if (!returnFocusTo) return;
            event.preventDefault();
            returnFocusTo.focus();
          }}
          className="fixed left-1/2 top-[calc(1rem_+_var(--edge-top))] max-h-[calc(100dvh-2rem_-_var(--edge-top))] flex w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 flex-col rounded-lg border border-black/10 bg-surface p-5 shadow-lg md:top-1/2 md:-translate-y-1/2"
        >
          <div className="min-h-0 flex-1 overflow-y-auto">
            <Dialog.Title className="text-base font-semibold">Connect Gmail to {workspaceName}</Dialog.Title>
            <ol className="flex flex-col gap-3 pt-4 text-sm">
              <li>
                1. <span className="font-medium">Create a label called Cockpit in Gmail</span>, if you have not yet.
              </li>
              <li>
                2. <span className="font-medium">Sign in with Google.</span> Google will warn that it has not
                verified Cockpit. Choose Advanced, then Go to Cockpit, and allow it to change your mail: that is
                what lets it take the label off.
              </li>
              <li>
                3. <span className="font-medium">Label any conversation Cockpit</span> and it becomes a task in this
                workspace’s Inbox within a few minutes. Conversations already labelled come in straight away.
              </li>
            </ol>
            <Dialog.Description className="pt-4 text-sm text-ink-faint">
              The label and the task stay in step. Finish or dismiss the task and Cockpit takes the label off;
              reopen it and the label comes back. Take the label off in Gmail, or delete the mail, and the task is
              marked done. Cockpit reads only conversations carrying the label.
            </Dialog.Description>
          </div>

          <div className="flex justify-end gap-2 pt-4">
            <Dialog.Close className="shrink-0 rounded-md border border-black/10 px-3 py-1.5 text-sm text-ink-soft hover:bg-accent-tint hover:text-accent-deep">
              Cancel
            </Dialog.Close>
            <button
              type="button"
              // Leaves the application, as signing in does, rather than
              // opening a popup nothing else in this app uses.
              onClick={() => window.location.assign(connectGmailPath(workspaceId))}
              className="shrink-0 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-deep"
            >
              Sign in with Google
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
