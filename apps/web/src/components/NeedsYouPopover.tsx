import type { RefObject } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { NO_QUESTION_SAID, type NeedsYouBox } from '../agentRunChip';
import { QUIET_BUTTON, STRIP_BUTTON } from './StripChoices';

/**
 * The box a linkless *Needs you* chip opens (issue 1770): what Claude is asking,
 * where to answer it, and *End Claude run*. Loaded on the first click, as the
 * row's other popovers are, so the popover library stays out of the first load.
 */

const BOX =
  'z-floating w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-shade/10 bg-surface p-3 text-sm text-ink shadow-lg';

export function NeedsYouPopover({
  anchor,
  box,
  onEnd,
  onClose,
}: {
  anchor: RefObject<HTMLElement | null>;
  box: NeedsYouBox;
  /** *End Claude run*, chosen in the box. */
  onEnd: () => void;
  onClose: () => void;
}) {
  return (
    <Popover.Root open onOpenChange={(open) => !open && onClose()}>
      <Popover.Anchor virtualRef={anchor} />
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
            onClick={() => {
              onEnd();
              onClose();
            }}
            className={`${STRIP_BUTTON} ${QUIET_BUTTON} mt-3`}
          >
            End Claude run
          </Popover.Close>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
