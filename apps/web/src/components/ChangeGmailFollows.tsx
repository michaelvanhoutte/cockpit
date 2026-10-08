import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { gmailMarkSchema, uuidv7, type GmailMark, type SourceAccount } from '@cockpit/shared';
import { refusalFrom, useCommand } from '../api/queries';
import { FollowedMarkChoice } from './ConnectGmail';

/** What switching to each mark does, said before Save. */
const AFTER_SWITCHING: Record<GmailMark, string> = {
  label:
    'Conversations labelled Cockpit, whatever their age, become tasks within a few minutes, and the label and the task stay in step. Tasks that came in by star stay as they are until it follows the star again.',
  star: 'Only conversations starred or flagged from now on become tasks: ones starred already stay out. Tasks that came in by label stay as they are until it follows the label again.',
};

/**
 * "Change what's followed…" on a Gmail row ("Change what a Gmail connection
 * follows, without reconnecting", issue 824): the Connect window's own choice
 * of mark, starting at the one followed now, and nothing to sign in to.
 *
 * **A form, not a question**: nothing is sent until Save, and Save with the
 * mark unchanged sends nothing; Cancel, Escape and pressing outside close it
 * without asking. Nested over `ManageConnections`'s window, as `ConnectGmail`
 * is, and its row names the new mark once the server has agreed to it.
 */
export function ChangeGmailFollows({
  account,
  workspaceId,
  onClose,
  returnFocusTo,
}: {
  /** The row it was opened from; absent, the window is shut. */
  account: SourceAccount | null;
  workspaceId: string;
  onClose: () => void;
  returnFocusTo?: HTMLElement | null;
}) {
  return (
    <Dialog.Root open={account !== null} onOpenChange={(nowOpen) => !nowOpen && onClose()}>
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
          {/* Its own component, so each opening starts at the mark followed now. */}
          {account && <Choice account={account} workspaceId={workspaceId} onClose={onClose} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Choice({ account, workspaceId, onClose }: { account: SourceAccount; workspaceId: string; onClose: () => void }) {
  // The value is Gmail's own mark; anything else reads as the label it starts at.
  const followedNow: GmailMark = gmailMarkSchema.safeParse(account.follows?.value).data ?? 'label';
  const [follows, setFollows] = useState<GmailMark>(followedNow);
  const command = useCommand();
  const refusal = refusalFrom(command);

  const save = () => {
    if (follows === followedNow) {
      onClose();
      return;
    }
    command.mutate(
      {
        name: 'set_gmail_follows',
        payload: {
          commandId: uuidv7(),
          issuedAt: new Date().toISOString(),
          workspaceId,
          sourceAccountId: account.id,
          follows,
        },
      },
      { onSuccess: onClose },
    );
  };

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Dialog.Title className="text-base font-semibold">What {account.displayName} follows</Dialog.Title>
        <FollowedMarkChoice value={follows} onChange={setFollows} />
        <Dialog.Description className="pt-4 text-sm text-ink-faint">{AFTER_SWITCHING[follows]}</Dialog.Description>
        {refusal && (
          <p role="alert" className="pt-3 text-sm text-over">
            {refusal}
          </p>
        )}
      </div>

      <div className="flex justify-end gap-2 pt-4">
        <Dialog.Close
          disabled={command.isPending}
          className="shrink-0 rounded-md border border-shade/10 px-3 py-1.5 text-sm text-ink-soft hover:bg-accent-tint hover:text-accent-deep disabled:opacity-50"
        >
          Cancel
        </Dialog.Close>
        <button
          type="button"
          onClick={save}
          disabled={command.isPending}
          className="shrink-0 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
        >
          Save
        </button>
      </div>
    </>
  );
}
