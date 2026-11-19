import { createPortal } from 'react-dom';
import { useRoomForTheInbox } from '../roomForTheInbox';
import { useOpenConnectionHistory } from '../settingsOpener';
import { useCheckConnections } from '../useCheckConnections';
import type { Checkable } from '../checkConnections';

/**
 * The Inbox's ↻ and the note it leaves ("Inbox: mail you just labelled waits for the five-minute check, or a Check now per connection in Settings: add a ↻ to the Inbox heading that checks them all now", issue 1835): the button where it is drawn in the heading's row, and the note in `noteSlot`, under the heading. Its own chunk, fetched once the Workspace lists a connection to check, since nothing on first paint needs it.
 */
export default function CheckConnections({
  workspaceId,
  checkable,
  noteSlot,
}: {
  workspaceId: string;
  checkable: readonly Checkable[];
  noteSlot: HTMLElement | null;
}) {
  const check = useCheckConnections(workspaceId, checkable);
  const room = useRoomForTheInbox();
  const openHistory = useOpenConnectionHistory();
  const { note } = check;
  return (
    <>
      <button
        type="button"
        onClick={check.press}
        title="Check connections now"
        aria-label="Check connections now"
        className="rounded px-1 text-sm leading-none text-ink-faint hover:text-ink"
      >
        <span aria-hidden="true" className={`inline-block ${check.checking ? 'animate-spin' : ''}`}>
          ↻
        </span>
      </button>
      {note &&
        noteSlot &&
        createPortal(
          <div role="status" className={`mt-1 text-xs ${note.ok ? 'text-ink-soft' : 'text-over-ink'}`}>
            <p>{note.text}</p>
            {note.failed.map((one) => (
              <p key={one.sourceAccountId}>
                {/* A desk opens the connection's history in Settings; a phone has no Connections to open it in. */}
                {room && openHistory ? (
                  <button type="button" className="underline" onClick={() => openHistory(workspaceId, one.sourceAccountId)}>
                    {one.name}
                  </button>
                ) : (
                  one.name
                )}{' '}
                failed
              </p>
            ))}
          </div>,
          noteSlot,
        )}
    </>
  );
}
