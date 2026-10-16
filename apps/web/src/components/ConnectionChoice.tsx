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
  /** What the connector asks, where it asks a question. */
  choice?: ConnectorChoice | undefined;
  /** How the connector speaks of names, where it reports any: the tick box is drawn when present (issue 1147). */
  names?: ConnectorNames | undefined;
  /** The option to start at - a reconnect's own choice - where it is one of the options. */
  startAt?: string | undefined;
  /** Whether the tick box starts ticked - a reconnected row's own value; unticked on a first Connect. */
  startFilesByName?: boolean | undefined;
}

/** What the person answered before Connect leaves: each part is present only where the connector asked it. */
export interface ConnectAnswer {
  choice?: string;
  filesByName?: boolean;
}

/**
 * The step before the source ("Ask a connection's one choice on connecting,
 * and change it later", issue 942): the connector's own question, and for a
 * connector that reports names whether it files by them ("Ask on Connect
 * whether a mail connection files by label or category", issue 1147), answered
 * before Connect leaves, the answers riding the address to the sign-in that
 * carries them back. Starts at the connector's first option and unticked every
 * time it opens, or at a reconnected row's own values.
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
  onConnect: (answer: ConnectAnswer) => void;
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

function Question({ connector, onConnect }: { connector: Asked; onConnect: (answer: ConnectAnswer) => void }) {
  const { choice, names } = connector;
  const [value, setValue] = useState(
    choice && (choice.options.find((option) => option.value === connector.startAt)?.value ?? choice.options[0]!.value),
  );
  const [filesByName, setFilesByName] = useState(connector.startFilesByName ?? false);
  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Dialog.Title className="text-base font-semibold">Connect {connector.displayName}</Dialog.Title>
        <Dialog.Description className="sr-only">Choose before signing in.</Dialog.Description>
        {choice && value !== undefined && (
          <ChoiceQuestion choice={choice} value={value} onChange={setValue} />
        )}
        {names && <FilesByName names={names} checked={filesByName} onChange={setFilesByName} />}
      </div>
      <div className="flex justify-end gap-2 pt-4">
        <Dialog.Close className="shrink-0 rounded-md border border-shade/10 px-3 py-1.5 text-sm text-ink-soft hover:bg-accent-tint hover:text-accent-deep">
          Cancel
        </Dialog.Close>
        <button
          type="button"
          // Leaves the application, as every Connect does.
          onClick={() =>
            onConnect({
              ...(choice && typeof value === 'string' ? { choice: value } : {}),
              ...(names ? { filesByName } : {}),
            })
          }
          className="shrink-0 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover"
        >
          Connect
        </button>
      </div>
    </>
  );
}

/** How a connector that reports names speaks of them (issue 1146). */
export type ConnectorNames = NonNullable<RegisteredConnector['names']>;

/** The name the example line files by: one a person might well have given a Panel. */
const EXAMPLE_NAME = 'Customer Atlas';

/**
 * Whether the connection files what it brings in on the Panel named after its
 * label or category, in the connector's own noun, with the one faint line
 * saying what that does and when it does not (issue 1146).
 */
function FilesByName({
  names,
  checked,
  onChange,
}: {
  names: ConnectorNames;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="pt-4">
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
          className="mt-0.5"
          aria-describedby="files-by-name-example"
        />
        File it on the panel named after its {names.noun}
      </label>
      <p id="files-by-name-example" className="pl-6 pt-1 text-sm text-ink-faint">
        So {names.example} {EXAMPLE_NAME} lands on the {EXAMPLE_NAME} panel instead of the Inbox. A {names.noun} that
        matches no panel, or panels on two dashboards, leaves it in the Inbox.
      </p>
    </div>
  );
}

/**
 * *Change…* on a connected row: the connector's own question again, starting at
 * the choice held now, and - for a connector that reports names - whether it
 * files by them, at the value held now; nothing to sign in to. **A form, not a
 * question**: nothing is sent until Save, Save with nothing changed sends
 * nothing, and Cancel, Escape and pressing outside close it without asking. Its
 * row says what changed once the server has agreed to it.
 */
export function ChangeConnectionChoice({
  account,
  choice,
  names = null,
  workspaceId,
  onClose,
  returnFocusTo,
}: {
  /** The row it was opened from; absent, the window is shut. */
  account: SourceAccount | null;
  /** What its connector asks, where it asks anything. */
  choice: ConnectorChoice | null;
  /** How its connector speaks of names, where it reports any. */
  names?: ConnectorNames | null;
  workspaceId: string;
  onClose: () => void;
  returnFocusTo?: HTMLElement | null;
}) {
  return (
    <Dialog.Root
      open={account !== null && (choice !== null || names !== null)}
      onOpenChange={(nowOpen) => !nowOpen && onClose()}
    >
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
          {account && (choice || names) && (
            <Changing account={account} choice={choice} names={names} workspaceId={workspaceId} onClose={onClose} />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Changing({
  account,
  choice,
  names,
  workspaceId,
  onClose,
}: {
  account: SourceAccount;
  choice: ConnectorChoice | null;
  names: ConnectorNames | null;
  workspaceId: string;
  onClose: () => void;
}) {
  // A value no longer among the options reads as the first, which Save then sets.
  const heldNow = !choice
    ? undefined
    : choice.options.some((option) => option.value === account.follows)
      ? account.follows!
      : choice.options[0]!.value;
  const [value, setValue] = useState(heldNow);
  const [filesByName, setFilesByName] = useState(account.filesByName);
  const command = useCommand();
  const refusal = refusalFrom(command);

  const save = async () => {
    const envelope = { issuedAt: new Date().toISOString(), workspaceId, sourceAccountId: account.id };
    try {
      if (choice && value !== undefined && value !== account.follows) {
        await command.mutateAsync({
          name: 'set_connection_choice',
          payload: { ...envelope, commandId: uuidv7(), choice: value },
        });
      }
      if (names && filesByName !== account.filesByName) {
        await command.mutateAsync({
          name: 'set_connection_files_by_name',
          payload: { ...envelope, commandId: uuidv7(), filesByName },
        });
      }
    } catch {
      // Said under the form (`refusal`), which stays open.
      return;
    }
    onClose();
  };

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Dialog.Title className="text-base font-semibold">Change {account.displayName}</Dialog.Title>
        <Dialog.Description className="sr-only">Choose again without signing in.</Dialog.Description>
        {choice && value !== undefined && <ChoiceQuestion choice={choice} value={value} onChange={setValue} />}
        {names && <FilesByName names={names} checked={filesByName} onChange={setFilesByName} />}
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
          onClick={() => void save()}
          disabled={command.isPending}
          className="shrink-0 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
        >
          Save
        </button>
      </div>
    </>
  );
}
