import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  DUE_IN_DAYS_MAX,
  DUE_IN_DAYS_MIN,
  uuidv7,
  type RegisteredConnector,
  type SourceAccount,
} from '@cockpit/shared';
import { whyNotDone } from '../api/queries';
import { useChangeConnection } from '../api/sourceAccounts';
import { useUndo } from '../undo';
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
  /** The connector's own sentence, said above its question - for a connector that asks nothing, the whole of what the window says. */
  text?: string | undefined;
  /** What the connector asks, where it asks a question. */
  choice?: ConnectorChoice | undefined;
  /** How the connector speaks of names, where it reports any: the tick box is drawn when present (issue 1147). */
  names?: ConnectorNames | undefined;
  /** The option to start at - a reconnect's own choice - where it is one of the options. */
  startAt?: string | undefined;
  /** Whether the tick box starts ticked - a reconnected row's own value; unticked on a first Connect. */
  startFilesByName?: boolean | undefined;
  /** Whether the connector is pulled: the due date tick box is drawn when it is (issue 1409). */
  pulled?: boolean | undefined;
  /** The days a reconnected row holds, which start the due date tick box ticked at that number; none on a first Connect. */
  startDueInDays?: number | null | undefined;
}

/** What the person answered before Connect leaves: each part is present only where the connector asked it. */
export interface ConnectAnswer {
  choice?: string;
  filesByName?: boolean;
  /** Days after it arrives each Item is due, or `null` for none (issue 1409). */
  dueInDays?: number | null;
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
  const { choice, names, pulled } = connector;
  const [value, setValue] = useState(
    choice && (choice.options.find((option) => option.value === connector.startAt)?.value ?? choice.options[0]!.value),
  );
  const [filesByName, setFilesByName] = useState(connector.startFilesByName ?? false);
  const dueDate = useDueDate(connector.startDueInDays ?? null);
  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Dialog.Title className="text-base font-semibold">Connect {connector.displayName}</Dialog.Title>
        <Dialog.Description className="sr-only">Choose before signing in.</Dialog.Description>
        {connector.text && <p className="pt-2 text-sm text-ink-faint">{connector.text}</p>}
        {choice && value !== undefined && (
          <ChoiceQuestion choice={choice} value={value} onChange={setValue} />
        )}
        {names && <FilesByName names={names} checked={filesByName} onChange={setFilesByName} />}
        {pulled && <GivesADueDate {...dueDate} />}
      </div>
      <div className="flex justify-end gap-2 pt-4">
        <Dialog.Close className="shrink-0 rounded-md border border-shade/10 px-3 py-1.5 text-sm text-ink-soft hover:bg-accent-tint hover:text-accent-deep">
          Cancel
        </Dialog.Close>
        <button
          type="button"
          // Leaves the application, as every Connect does - unless the days typed are not a number of days.
          onClick={() => {
            const dueInDays = pulled ? dueDate.answer() : null;
            if (dueInDays === 'refused') return;
            onConnect({
              ...(choice && typeof value === 'string' ? { choice: value } : {}),
              ...(names ? { filesByName } : {}),
              ...(pulled ? { dueInDays } : {}),
            });
          }}
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

/** The days the tick box offers when it is ticked on a connection that holds none. */
const DAYS_TO_START_AT = 3;

/**
 * The due date tick box and its number, held together: ticked at the days a row
 * holds or unticked, and the number as typed so that a half-typed one is not
 * rewritten under the cursor. `answer` is what Save or Connect sends - none
 * where unticked, the days where they are a whole number in range, and
 * `refused` (shown beside the field) where they are not (issue 1409).
 */
function useDueDate(held: number | null) {
  const [on, setOn] = useState(held !== null);
  const [days, setDays] = useState(String(held ?? DAYS_TO_START_AT));
  const [refused, setRefused] = useState(false);
  const answer = (): number | null | 'refused' => {
    if (!on) return null;
    const typed = days.trim();
    const asked = /^\d+$/.test(typed) ? Number(typed) : NaN;
    if (asked >= DUE_IN_DAYS_MIN && asked <= DUE_IN_DAYS_MAX) {
      setRefused(false);
      return asked;
    }
    setRefused(true);
    return 'refused';
  };
  return {
    on,
    days,
    refused,
    onTick: (ticked: boolean) => {
      setOn(ticked);
      setRefused(false);
    },
    onDays: (typed: string) => {
      setDays(typed);
      setRefused(false);
    },
    answer,
  };
}

/**
 * Whether the connection gives each Item it brings in a due date a set number
 * of days after the day it arrives, with the one faint line saying why and what
 * comes first (issue 1409). The days are asked only once the box is ticked.
 */
function GivesADueDate({
  on,
  days,
  refused,
  onTick,
  onDays,
}: {
  on: boolean;
  days: string;
  refused: boolean;
  onTick: (ticked: boolean) => void;
  onDays: (typed: string) => void;
}) {
  return (
    <div className="pt-4">
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={on}
          onChange={(event) => onTick(event.target.checked)}
          className="mt-0.5"
          aria-describedby="gives-a-due-date-why"
        />
        Give it a due date
      </label>
      {on && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pl-6 pt-1.5 text-sm">
          <input
            type="number"
            inputMode="numeric"
            min={DUE_IN_DAYS_MIN}
            max={DUE_IN_DAYS_MAX}
            step={1}
            value={days}
            onChange={(event) => onDays(event.target.value)}
            aria-label="Days after it arrives"
            aria-invalid={refused}
            aria-describedby={refused ? 'gives-a-due-date-refused' : undefined}
            // 8px wider than the design's 56px: three digits clear the spin buttons.
            className="w-16 rounded-md border border-shade/20 bg-field px-2 py-1 text-right text-sm text-ink-strong focus:border-accent focus:outline-none"
          />
          <span>days after it arrives</span>
          {refused && (
            <span id="gives-a-due-date-refused" role="alert" className="text-over-ink">
              Use a whole number from {DUE_IN_DAYS_MIN} to {DUE_IN_DAYS_MAX}.
            </span>
          )}
        </div>
      )}
      <p id="gives-a-due-date-why" className="pl-6 pt-1 text-sm text-ink-faint">
        So you are reminded to follow up. A date the message names, or one you set, comes first.
      </p>
    </div>
  );
}

/**
 * *Change…* on a connected row: the connector's own question again, starting at
 * the choice held now, and - for a connector that reports names - whether it
 * files by them, at the value held now; nothing to sign in to. **A form, not a
 * question**: nothing is sent until Save, Save with nothing changed sends
 * nothing, and Cancel, Escape and pressing outside close it without asking.
 * **Save closes it at the click** and the row says what changed at once ("Show a
 * connection change the moment you make it", issue 1369); a change the server
 * refuses puts the row back and says why in the undo bar.
 */
export function ChangeConnectionChoice({
  account,
  choice,
  names = null,
  pulled = false,
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
  /** Whether its connector is pulled, which offers the due date (issue 1409). */
  pulled?: boolean;
  workspaceId: string;
  onClose: () => void;
  returnFocusTo?: HTMLElement | null;
}) {
  return (
    <Dialog.Root
      open={account !== null && (choice !== null || names !== null || pulled)}
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
          {account && (choice || names || pulled) && (
            <Changing
              account={account}
              choice={choice}
              names={names}
              pulled={pulled}
              workspaceId={workspaceId}
              onClose={onClose}
            />
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
  pulled,
  workspaceId,
  onClose,
}: {
  account: SourceAccount;
  choice: ConnectorChoice | null;
  names: ConnectorNames | null;
  pulled: boolean;
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
  // `?? null`: a row drawn from a read before this field reads as none.
  const heldDays = account.dueInDays ?? null;
  const dueDate = useDueDate(heldDays);
  const changeConnection = useChangeConnection();
  const offerToUndo = useUndo();

  const save = () => {
    // Refused beside the field, and nothing sent, while the days are not a number of days.
    const dueInDays = pulled ? dueDate.answer() : heldDays;
    if (dueInDays === 'refused') return;
    const envelope = { issuedAt: new Date().toISOString(), workspaceId, sourceAccountId: account.id };
    const refused = (failure: unknown) => {
      offerToUndo({ what: `“${account.displayName}” was not changed. ${whyNotDone(failure)}` });
    };
    // Each half is its own change, so one the server refuses does not undo the other.
    if (choice && value !== undefined && value !== account.follows) {
      changeConnection({
        name: 'set_connection_choice',
        payload: { ...envelope, commandId: uuidv7(), choice: value },
      }).catch(refused);
    }
    if (names && filesByName !== account.filesByName) {
      changeConnection({
        name: 'set_connection_files_by_name',
        payload: { ...envelope, commandId: uuidv7(), filesByName },
      }).catch(refused);
    }
    if (pulled && dueInDays !== heldDays) {
      changeConnection({
        name: 'set_connection_due_in_days',
        payload: { ...envelope, commandId: uuidv7(), dueInDays },
      }).catch(refused);
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
        {pulled && <GivesADueDate {...dueDate} />}
      </div>
      <div className="flex justify-end gap-2 pt-4">
        <Dialog.Close className="shrink-0 rounded-md border border-shade/10 px-3 py-1.5 text-sm text-ink-soft hover:bg-accent-tint hover:text-accent-deep">
          Cancel
        </Dialog.Close>
        <button
          type="button"
          onClick={save}
          className="shrink-0 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover"
        >
          Save
        </button>
      </div>
    </>
  );
}
