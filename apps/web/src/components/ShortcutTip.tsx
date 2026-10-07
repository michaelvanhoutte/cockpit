import { AGENT_DOCK_KEY } from '../agentDockHidden';
import { CAPTURE_KEY } from '../captureShortcut';
import { FILTER_KEY } from '../filterKey';
import { INBOX_KEY } from '../inboxCollapsed';
import { PANEL_LIST_KEY } from '../panelList';
import type { TipControl } from '../shortcutTip';
import { BOTTOM_CENTRE_STRIP, useAnUndoIsOffered } from '../undo';

/** What each control's tip says. */
export const TIPS: Record<TipControl, string> = {
  capture: `Tip: press ${CAPTURE_KEY.toUpperCase()} to capture from anywhere`,
  inbox: `Tip: press ${INBOX_KEY.toUpperCase()} to collapse or open the Inbox`,
  panels: `Tip: press ${PANEL_LIST_KEY.toUpperCase()} to go to a Panel`,
  filter: `Tip: press ${FILTER_KEY.toUpperCase()} to filter`,
  dock: `Tip: press ${AGENT_DOCK_KEY.toUpperCase()} to hide or show the agents’ dock`,
};

/**
 * The toast, where the undo offer is drawn. It stands aside while an undo is
 * offered rather than covering it: the way back matters more than a hint.
 */
export function ShortcutTip({ control, onDismiss }: { control: TipControl; onDismiss: () => void }) {
  const undoOffered = useAnUndoIsOffered();
  if (undoOffered) return null;
  return (
    <div role="status" className={BOTTOM_CENTRE_STRIP}>
      <div
        // Kept from the document, where an open window (Capture, opened by the
        // very click that showed this) would read a press here as one outside
        // it and close: the tip must never get in the way.
        onPointerDown={(event) => event.stopPropagation()}
        className="pointer-events-auto flex max-w-[min(32rem,calc(100vw-2rem))] items-center gap-3 rounded-lg bg-ink px-4 py-2.5 text-sm text-white shadow-lg"
      >
        <span className="min-w-0 flex-1">{TIPS[control]}</span>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss the tip"
          className="pointer-events-auto shrink-0 rounded px-2 py-1 text-white/70 hover:bg-white/10 hover:text-white"
        >
          {'✕'}
        </button>
      </div>
    </div>
  );
}

// Also the default export, for the lazy `import()` Layout.tsx loads this behind.
export default ShortcutTip;
