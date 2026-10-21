import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { phoneCodeSentSchema, phoneConnectedSchema } from '@cockpit/shared';
import { api } from '../api/client';

/**
 * Connecting a phone by confirming a code texted to it ("Connect a phone in
 * Settings by confirming a code texted to it", issue 1335): the number, a code
 * sent to it, and the code typed back. Two requests and nothing pending
 * between them - the source holds the code - so what is on screen is only what
 * the person has typed and what the server has said.
 *
 * **A refusal is said under the form and nothing typed is lost**: a number
 * that is not accepted, a code that is wrong or has lapsed, an hour's codes
 * spent, the source down. The person corrects the field and presses again.
 *
 * **Nested over `ManageConnections`'s window**, like the connector's question,
 * so closing it leaves the connections list where it was.
 */

const FIELD =
  'min-h-9 w-full rounded-md border border-shade/10 bg-field px-3 text-sm placeholder:text-ink-faint focus:border-accent focus:outline-none sm:min-h-0 sm:py-1.5';

const DIALOG_CLASS =
  'fixed z-floating left-1/2 top-[calc(1rem_+_var(--edge-top))] max-h-[calc(100dvh-2rem_-_var(--edge-top))] flex w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 flex-col rounded-lg border border-shade/10 bg-surface p-5 shadow-lg md:top-1/2 md:-translate-y-1/2';

/** What a failure that carried no sentence of the server's says: the request never got an answer worth reading. */
const DID_NOT_REACH = 'That did not reach the server. Try again.';

/** The connector being connected, as the form needs to name it. */
export interface PhoneConnector {
  id: string;
  displayName: string;
  /** The number a connected phone texts. */
  textTo: string;
}

/**
 * What the server answered for one of the two requests: the body it parsed
 * from, or the sentence it said under a refusal. A status the server gives no
 * sentence for (not signed in, an error of its own) reads as not having
 * reached it.
 */
async function answer<T>(
  asked: Promise<Response>,
  parse: (body: unknown) => T,
): Promise<{ ok: true; body: T } | { ok: false; error: string }> {
  try {
    const res = await asked;
    const body: unknown = await res.json().catch(() => null);
    if (res.ok) return { ok: true, body: parse(body) };
    const error = [400, 404, 429, 502].includes(res.status) ? (body as { error?: unknown } | null)?.error : undefined;
    return { ok: false, error: typeof error === 'string' ? error : DID_NOT_REACH };
  } catch {
    return { ok: false, error: DID_NOT_REACH };
  }
}

export function ConnectPhone({
  connector,
  workspaceId,
  onConnected,
  onClose,
  returnFocusTo,
}: {
  /** The connector being connected; absent, the window is shut. */
  connector: PhoneConnector | null;
  workspaceId: string;
  /** Called once a number is connected, for the list to be read again. */
  onConnected: () => void;
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
          {/* Its own component, so every opening starts from an empty form. */}
          {connector && <Form connector={connector} workspaceId={workspaceId} onConnected={onConnected} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Form({
  connector,
  workspaceId,
  onConnected,
}: {
  connector: PhoneConnector;
  workspaceId: string;
  onConnected: () => void;
}) {
  const [number, setNumber] = useState('');
  const [code, setCode] = useState('');
  /** Whether a code has been texted, which is what shows the code field. */
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The number as the server connected it, once it has. */
  const [connected, setConnected] = useState<string | null>(null);

  const param = { workspaceId, connectorId: connector.id };
  const phone = api.v1.workspaces[':workspaceId'].connections[':connectorId'].phone;

  const sendCode = async () => {
    setPending(true);
    setError(null);
    const result = await answer(phone.code.$post({ param, json: { number } }), (body) => phoneCodeSentSchema.parse(body));
    setPending(false);
    if (result.ok) setSent(true);
    else setError(result.error);
  };

  const confirm = async () => {
    setPending(true);
    setError(null);
    const result = await answer(phone.confirm.$post({ param, json: { number, code } }), (body) =>
      phoneConnectedSchema.parse(body),
    );
    setPending(false);
    if (result.ok) {
      setConnected(result.body.number);
      onConnected();
    } else setError(result.error);
  };

  if (connected !== null) {
    return (
      <>
        <Dialog.Title className="text-base font-semibold">Connected</Dialog.Title>
        <Dialog.Description className="pt-3 text-sm">
          {connected} is connected. Text {connector.textTo} and the note lands in your Inbox.
        </Dialog.Description>
        <div className="flex justify-end pt-4">
          <Dialog.Close className="shrink-0 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover">
            Done
          </Dialog.Close>
        </div>
      </>
    );
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!pending) void (sent ? confirm() : sendCode());
      }}
    >
      <Dialog.Title className="text-base font-semibold">Connect a phone</Dialog.Title>
      <Dialog.Description className="pt-1 text-sm text-ink-faint">
        Cockpit texts a code to your mobile number, to check it is yours. Belgian mobile numbers only.
      </Dialog.Description>
      <label className="block pt-4 text-sm">
        Mobile number
        <input
          type="tel"
          autoComplete="tel"
          inputMode="tel"
          value={number}
          onChange={(event) => setNumber(event.target.value)}
          placeholder="0470 12 34 56"
          className={`${FIELD} mt-1`}
        />
      </label>
      {sent && (
        <label className="block pt-3 text-sm">
          Code
          <input
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            className={`${FIELD} mt-1`}
          />
        </label>
      )}
      {error && (
        <p role="alert" className="pt-3 text-sm text-over-ink">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2 pt-4">
        <Dialog.Close className="shrink-0 rounded-md border border-shade/10 px-3 py-1.5 text-sm text-ink-soft hover:bg-accent-tint hover:text-accent-deep">
          Cancel
        </Dialog.Close>
        {sent && (
          <button
            type="button"
            disabled={pending}
            onClick={() => void sendCode()}
            className="shrink-0 rounded-md border border-shade/10 px-3 py-1.5 text-sm text-ink-soft hover:bg-accent-tint hover:text-accent-deep disabled:opacity-50"
          >
            Send a new code
          </button>
        )}
        <button
          type="submit"
          disabled={pending}
          className="shrink-0 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
        >
          {sent ? 'Confirm' : 'Send code'}
        </button>
      </div>
    </form>
  );
}
