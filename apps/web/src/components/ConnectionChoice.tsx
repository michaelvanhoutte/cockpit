import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { uuidv7, type RegisteredConnector, type SourceAccount } from '@cockpit/shared';
import { refusalFrom, useCommand } from '../api/queries';
import { Segmented } from './Segmented';

/** What a connector asks once per connection: its question and the options that answer it (issue 942). */
export type ConnectorChoice = NonNullable<RegisteredConnector['choice']>;

const DIALOG_CLASS =
  'fixed z-floating left-1/2 top-[calc(1rem_+_var(--edge-top))] max-h-[calc(100dvh-2rem_-_var(--edge-top))] flex w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 flex-col rounded-lg border border-shade/10 bg-surface p-5 shadow-lg md:top-1/2 md:-translate-y-1/2';

/** The question and its options, as connecting asks them and as *Change…* asks them again. */
function ChoiceQuestion({
  choice,
  value,
  onChange,
}: {
  choice: ConnectorChoice;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <>
      <p className="pt-4 text-sm">{choice.question}</p>
      <Segmented
        label={choice.question}
        name="connection-choice"
        options={choice.options}
        value={value}
        onChange={onChange}
        className="mt-1 flex-wrap"
      />
    </>
  );
}

/** The connector being connected, as the question needs to name it. */
interface Asked {
  displayName: string;
  choice: ConnectorChoice;
  /** The option to start at - a reconnect's own choice - where it is one of the options. */
  startAt?: string | undefined;
}

/**
 * The step before the source ("Ask a connection's one choice on connecting,
 * and change it later", issue 942): the connector's own question, answered
 * before Connect leaves, the answer riding the address to the sign-in that
 * carries it back. Starts at the connector's first option every time it opens,
 * or at a reconnected row's own choice.
 *
 * **Nested over `ManageConnections`'s window**, so Cancel leaves the
 * connections list exactly where it was.
 */
export function ConnectWithChoice({
  connector,
  onConnect,
  onClose,
  returnFocusTo,
}: {
  /** The connector being connected; absent, the window is shut. */
  connector: Asked | null;
  /** Leaves for the source with the option picked. */
  onConnect: (value: string) => void;
  onClose: () => void;
  returnFocusTo?: HTMLElement | null;
}) {
  return (
    <Dialog.Root open={connector !== null} onOpenChange={(nowOpen) => !nowOpen && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-floating bg-scrim/30" />
        <Dialog.Content
          onCloseAutoFocus={(event) => {
            if (!returnFocusTo) return;
            event.preventDefault();
            returnFocusTo.focus();
          }}
          className={DIALOG_CLASS}
        >
          {/* Its own component, so the choice starts at the first option every time the window opens. */}
          {connector && <Question connector={connector} onConnect={onConnect} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Question({ connector, onConnect }: { connector: Asked; onConnect: (value: string) => void }) {
  const [value, setValue] = useState(
    connector.choice.options.find((option) => option.value === connector.startAt)?.value ??
      connector.choice.options[0]!.value,
  );
  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Dialog.Title className="text-base font-semibold">Connect {connector.displayName}</Dialog.Title>
        <Dialog.Description className="sr-only">Choose before signing in.</Dialog.Description>
        <ChoiceQuestion choice={connector.choice} value={value} onChange={setValue} />
      </div>
      <div className="flex justify-end gap-2 pt-4">
        <Dialog.Close className="shrink-0 rounded-md border border-shade/10 px-3 py-1.5 text-sm text-ink-soft hover:bg-accent-tint hover:text-accent-deep">
          Cancel
        </Dialog.Close>
        <button
          type="button"
          // Leaves the application, as every Connect does.
          onClick={() => onConnect(value)}
          className="shrink-0 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover"
        >
          Connect
        </button>
      </div>
    </>
  );
}

/**
 * *Change…* on a connected row: the connector's own question again, starting at
 * the choice held now, and nothing to sign in to. **A form, not a question**:
 * nothing is sent until Save, Save with the choice unchanged sends nothing,
 * and Cancel, Escape and pressing outside close it without asking. Its row
 * names the new choice once the server has agreed to it.
 */
export function ChangeConnectionChoice({
  account,
  choice,
  workspaceId,
  onClose,
  returnFocusTo,
}: {
  /** The row it was opened from; absent, the window is shut. */
  account: SourceAccount | null;
  /** What its connector asks. */
  choice: ConnectorChoice | null;
  workspaceId: string;
  onClose: () => void;
  returnFocusTo?: HTMLElement | null;
}) {
  return (
    <Dialog.Root open={account !== null && choice !== null} onOpenChange={(nowOpen) => !nowOpen && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-floating bg-shade/30" />
        <Dialog.Content
          onCloseAutoFocus={(event) => {
            if (!returnFocusTo) return;
            event.preventDefault();
            returnFocusTo.focus();
          }}
          className={DIALOG_CLASS}
        >
          {account && choice && (
            <Changing account={account} choice={choice} workspaceId={workspaceId} onClose={onClose} />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Changing({
  account,
  choice,
  workspaceId,
  onClose,
}: {
  account: SourceAccount;
  choice: ConnectorChoice;
  workspaceId: string;
  onClose: () => void;
}) {
  // A value no longer among the options reads as the first, which Save then sets.
  const heldNow = choice.options.some((option) => option.value === account.follows)
    ? account.follows!
    : choice.options[0]!.value;
  const [value, setValue] = useState(heldNow);
  const command = useCommand();
  const refusal = refusalFrom(command);

  const save = () => {
    if (value === account.follows) {
      onClose();
      return;
    }
    command.mutate(
      {
        name: 'set_connection_choice',
        payload: {
          commandId: uuidv7(),
          issuedAt: new Date().toISOString(),
          workspaceId,
          sourceAccountId: account.id,
          choice: value,
        },
      },
      { onSuccess: onClose },
    );
  };

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Dialog.Title className="text-base font-semibold">Change {account.displayName}</Dialog.Title>
        <Dialog.Description className="sr-only">Choose again without signing in.</Dialog.Description>
        <ChoiceQuestion choice={choice} value={value} onChange={setValue} />
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
