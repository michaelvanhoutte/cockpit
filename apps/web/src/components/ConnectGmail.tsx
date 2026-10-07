import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type { GmailMark } from '@cockpit/shared';
import { Segmented } from './Segmented';

/**
 * Connecting Gmail is a navigation, like Teams': the browser leaves for
 * Google and comes back to `/w/<workspaceId>?connections=gmail-connected|refused`.
 * By star it says so in the address, which the Worker carries through Google
 * ("Connect Gmail by star, and bring in conversations starred from then on",
 * issue 822).
 */
function connectGmailPath(workspaceId: string, follows: GmailMark): string {
  const path = `/v1/workspaces/${encodeURIComponent(workspaceId)}/connections/gmail/connect`;
  return follows === 'star' ? `${path}?follows=star` : path;
}

const MARKS: readonly { value: GmailMark; label: string }[] = [
  { value: 'label', label: 'Labelled Cockpit' },
  { value: 'star', label: 'Starred (flagged in Outlook)' },
];

/**
 * The one choice of mark, as connecting offers it and as "Change what's
 * followed…" offers it again ("Change what a Gmail connection follows,
 * without reconnecting", issue 824).
 */
export function FollowedMarkChoice({ value, onChange }: { value: GmailMark; onChange: (mark: GmailMark) => void }) {
  return (
    <>
      <p className="pt-4 text-sm">Bring in conversations</p>
      <Segmented
        label="Bring in conversations"
        name="gmail-follows"
        options={MARKS}
        value={value}
        onChange={onChange}
        className="mt-1 flex-wrap"
      />
    </>
  );
}

/**
 * The step before Google ("Connect a Gmail account to a workspace, and
 * disconnect it", issue 724): which mark brings a conversation in, what to do
 * in Gmail first, what Google is about to warn about and ask, and what a
 * conversation carrying the mark becomes - said here because the warning
 * reads like something gone wrong to anybody not told.
 *
 * **One mark, the label to start** (issue 822). The steps follow the choice:
 * creating the label is the label's alone, and by star only what is starred
 * from now on counts, since Gmail never says when a conversation was starred.
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
        <Dialog.Overlay className="fixed inset-0 z-floating bg-shade/30" />
        <Dialog.Content
          onCloseAutoFocus={(event) => {
            if (!returnFocusTo) return;
            event.preventDefault();
            returnFocusTo.focus();
          }}
          className="fixed z-floating left-1/2 top-[calc(1rem_+_var(--edge-top))] max-h-[calc(100dvh-2rem_-_var(--edge-top))] flex w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 flex-col rounded-lg border border-shade/10 bg-surface p-5 shadow-lg md:top-1/2 md:-translate-y-1/2"
        >
          {/* Its own component, so the choice starts at the label every time
              the window opens: the content unmounts when it closes. */}
          <Steps workspaceId={workspaceId} workspaceName={workspaceName} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Steps({ workspaceId, workspaceName }: { workspaceId: string; workspaceName: string }) {
  const [follows, setFollows] = useState<GmailMark>('label');
  const signIn = (
    <>
      <span className="font-medium">Sign in with Google.</span> Google will warn that it has not verified Cockpit.
      Choose Advanced, then Go to Cockpit, and allow it to change your mail
      {follows === 'label' ? ': that is what lets it take the label off.' : '.'}
    </>
  );
  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Dialog.Title className="text-base font-semibold">Connect Gmail to {workspaceName}</Dialog.Title>
        <FollowedMarkChoice value={follows} onChange={setFollows} />
        {follows === 'label' ? (
          <ol className="flex flex-col gap-3 pt-4 text-sm">
            <li>
              1. <span className="font-medium">Create a label called Cockpit in Gmail</span>, if you have not yet.
            </li>
            <li>2. {signIn}</li>
            <li>
              3. <span className="font-medium">Label any conversation Cockpit</span> and it becomes a task in this
              workspace’s Inbox within a few minutes. Conversations already labelled come in straight away.
            </li>
          </ol>
        ) : (
          <ol className="flex flex-col gap-3 pt-4 text-sm">
            <li>1. {signIn}</li>
            <li>
              2. <span className="font-medium">Star any conversation in Gmail, or flag it in Outlook,</span> and it
              becomes a task in this workspace’s Inbox within a few minutes. Only conversations starred or flagged
              from now on become tasks: ones starred already stay out.
            </li>
          </ol>
        )}
        <Dialog.Description className="pt-4 text-sm text-ink-faint">
          {follows === 'label'
            ? 'The label and the task stay in step. Finish or dismiss the task and Cockpit takes the label off; reopen it and the label comes back. Take the label off in Gmail, or delete the mail, and the task is marked done. Cockpit reads only conversations carrying the label.'
            : 'Cockpit reads only conversations starred from now on.'}
        </Dialog.Description>
      </div>

      <div className="flex justify-end gap-2 pt-4">
        <Dialog.Close className="shrink-0 rounded-md border border-shade/10 px-3 py-1.5 text-sm text-ink-soft hover:bg-accent-tint hover:text-accent-deep">
          Cancel
        </Dialog.Close>
        <button
          type="button"
          // Leaves the application, as signing in does, rather than
          // opening a popup nothing else in this app uses.
          onClick={() => window.location.assign(connectGmailPath(workspaceId, follows))}
          className="shrink-0 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover"
        >
          Sign in with Google
        </button>
      </div>
    </>
  );
}
