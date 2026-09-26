import { useEffect } from 'react';
import { CaptureNote } from './CaptureNote';
import { ManageWindow } from './ManageWindow';

/**
 * Capture over the screen you are on ("Capture over the screen you are on, and
 * open it with C", issue 536): what the header's Capture tab and `C` open at a
 * desk, with the full form - several lines, the Type and Where chips, *Just
 * captured* under it - and Escape back to where you were, the note already in
 * the Inbox beside it.
 *
 * **Over the screen rather than at an address**, like the window types are
 * managed in (components/ManageWindow.tsx): there is nothing to come back from.
 * The page (pages/CapturePage.tsx) is what a link opens.
 *
 * The form is mounted only while the window is open, so a workspace chosen in
 * it lasts until it closes and reopening starts on `startsIn` again.
 */
export function CaptureWindow({
  open,
  onClose,
  startsIn,
}: {
  open: boolean;
  onClose: () => void;
  /** The workspace you are in, or null for *Any workspace*. */
  startsIn: string | null;
}) {
  /**
   * **Escape is this window's, whatever else is open behind it.** Radix hands
   * Escape to the newest layer, and a docked Item's form remounts, and so
   * becomes the newest, each time it follows a capture to the note just made -
   * so Escape pressed in the box closed the form and left this window up. Taken
   * from the window ahead of the document, where Radix listens.
   */
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  return (
    <ManageWindow title="Capture" open={open} onClose={onClose}>
      <div className="mt-3 flex min-h-0 flex-1 flex-col overflow-y-auto">
        <CaptureNote startsIn={startsIn} />
      </div>
    </ManageWindow>
  );
}
