import * as Popover from '@radix-ui/react-popover';
import { NO_QUESTION_SAID, type NeedsYouBox } from '../agentRunChip';
import { QUIET_BUTTON, STRIP_BUTTON } from './StripChoices';

/**
 * A *Needs you* chip with no session to open ("End a Claude run from its row, and
 * make Needs you say what Claude is asking", issue 1770): a click opens a small
 * box saying what Claude is asking and where to answer it, with *End Claude run*.
 * Drawn from the run the held copy already carries, so it reaches no server.
 */

const BOX =
  'z-floating w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-shade/10 bg-surface p-3 text-sm text-ink shadow-lg';

export function NeedsYouChip({
  box,
  label,
  className,
  onEnd,
}: {
  box: NeedsYouBox;
  /** What the chip itself says. */
  label: string;
  className: string;
  /** *End Claude run*, chosen in the box. */
  onEnd: () => void;
}) {
  return (
    <Popover.Root>
      <Popover.Trigger
        type="button"
        // A control of the row's own, so a right-click on it is not the row's menu.
        onContextMenu={(event) => event.stopPropagation()}
        className={`${className} cursor-pointer`}
      >
        {label}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          className={BOX}
          // Drawn in a portal but inside the row in React's tree: what is pressed
          // here is the box's, never a click, key or swipe on the row.
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          onPointerUp={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <div className="font-medium">{box.title}</div>
          <blockquote className="mt-1 border-l-2 border-shade/20 pl-2 text-ink-soft">
            {box.question === NO_QUESTION_SAID ? box.question : `“${box.question}”`}
          </blockquote>
          <p className="mt-2 text-xs text-ink-faint">{box.where}</p>
          <Popover.Close
            type="button"
            onClick={onEnd}
            className={`${STRIP_BUTTON} ${QUIET_BUTTON} mt-3`}
          >
            End Claude run
          </Popover.Close>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
