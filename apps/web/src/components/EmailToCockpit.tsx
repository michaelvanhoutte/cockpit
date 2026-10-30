import { useEffect, useRef, useState } from 'react';
import {
  ACCOUNT_WIDE,
  emailAddressOf,
  newEmailLocalPart,
  uuidv7,
  type EmailToCockpit as EmailToCockpitHeld,
} from '@cockpit/shared';
import { useSendCommand, whyNotDone } from '../api/queries';
import { useUndo } from '../undo';
import { DeleteQuestion } from './DeleteQuestion';
import { RowMenu } from './Menu';
import { SettingsPanel } from './SettingsPanel';
import { SourceMark } from './SourceMark';

/** What the guest is told in place of *Get an address*: the account is everybody's. */
const GUEST_SENTENCE = 'Sign in with Google to get your own';

/**
 * Settings › Connections' *Your account* panel: the account's Email to Cockpit
 * address ("Get an Email to Cockpit address, and receive mail at it", issue
 * 1466). *Get an address* until pressed, then the address with *Copy* and a
 * menu of *Make a new address…* and *Turn off*, each asked first.
 *
 * `held` is what a Workspace's held copy says, which every Workspace's
 * carries. Drawn at once: the random part is made here, so a new address shows
 * before it is read back. A refusal puts back what the account holds and says
 * why, or says it in the undo bar once Settings has closed.
 */
export function EmailToCockpit({ held, guest }: { held: EmailToCockpitHeld; guest: boolean }) {
  const saved = held.localPart;
  /** A random part sent and not yet read back: a new one, or null for turned off. */
  const [chosen, setChosen] = useState<{ localPart: string | null } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [asking, setAsking] = useState<'renew' | 'turn-off' | null>(null);
  const askedFrom = useRef<HTMLElement | null>(null);
  const offerToUndo = useUndo();
  const send = useSendCommand();
  // Whether Settings is still open, since it may close before a refusal comes back.
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);
  // What the account holds wins once it is read, here or from another device.
  useEffect(() => {
    setChosen(null);
    setCopied(false);
  }, [saved]);

  const shown = chosen ? chosen.localPart : saved;
  const address = shown === null ? null : emailAddressOf(shown, held.domain);

  const choose = (localPart: string | null, what: string) => {
    setChosen({ localPart });
    setFailed(null);
    setCopied(false);
    send({
      name: 'set_email_address',
      payload: { commandId: uuidv7(), issuedAt: new Date().toISOString(), workspaceId: ACCOUNT_WIDE, localPart },
    }).catch((failure: unknown) => {
      if (!open.current) return offerToUndo({ what: `${what} did not happen. ${whyNotDone(failure)}` });
      setChosen(null);
      setFailed(`${what} did not happen. ${whyNotDone(failure)}`);
    });
  };

  const copy = () => {
    if (address === null) return;
    // Clipboard access can be refused; the address is on screen to select.
    void navigator.clipboard?.writeText(address).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };

  return (
    <SettingsPanel name="Your account" hint="The same in every workspace.">
      <div className="flex items-center gap-3">
        <SourceMark connectorId="email" />
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold text-ink-strong">Email to Cockpit</p>
          {address !== null && <p className="truncate text-sm text-ink-soft">{address}</p>}
        </div>
        {guest ? (
          <span className="shrink-0 text-sm text-ink-faint">{GUEST_SENTENCE}</span>
        ) : address === null ? (
          <button
            type="button"
            onClick={() => choose(newEmailLocalPart(), 'Getting an address')}
            className="shrink-0 rounded-md bg-accent px-3 py-1 text-xs font-medium text-on-accent hover:bg-accent-hover"
          >
            Get an address
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={copy}
              className="shrink-0 rounded-md border border-shade/20 px-2 py-1 text-xs text-ink hover:bg-accent-tint"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
            <RowMenu
              label="More for Email to Cockpit"
              entries={[
                {
                  label: 'Make a new address…',
                  onSelect: (from) => {
                    askedFrom.current = from;
                    setAsking('renew');
                  },
                },
                {
                  label: 'Turn off',
                  destructive: true,
                  onSelect: (from) => {
                    askedFrom.current = from;
                    setAsking('turn-off');
                  },
                },
              ]}
            />
          </>
        )}
      </div>
      {address !== null && (
        <p className="mt-2 text-xs text-ink-faint">Mail it to add a note; Cc or Bcc it to wait for a reply.</p>
      )}
      {failed && (
        <p role="alert" className="mt-2 text-sm text-over-ink">
          {failed}
        </p>
      )}
      <DeleteQuestion
        open={asking === 'renew'}
        question={`Make a new address? Mail to ${address ?? 'the old one'} will be refused.`}
        confirmLabel="Make a new address"
        confirmText="Make a new address"
        variant="affirmative"
        onCancel={() => setAsking(null)}
        onConfirm={() => {
          setAsking(null);
          choose(newEmailLocalPart(), 'Making a new address');
        }}
        returnFocusTo={askedFrom.current}
      />
      <DeleteQuestion
        open={asking === 'turn-off'}
        question={`Turn off Email to Cockpit? Mail to ${address ?? 'it'} will be refused.`}
        confirmLabel="Turn off Email to Cockpit"
        confirmText="Turn off"
        onCancel={() => setAsking(null)}
        onConfirm={() => {
          setAsking(null);
          choose(null, 'Turning it off');
        }}
        returnFocusTo={askedFrom.current}
      />
    </SettingsPanel>
  );
}
