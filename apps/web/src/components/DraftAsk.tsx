import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { DRAFT_POINTS_LIMIT } from '@cockpit/shared';
import { cancelDraftQuestion, useDraftQuestion, type Asking, type DraftAnswer } from '../draftAsk';

/**
 * The box *Email…* and *Reply…* ask before a draft is made where Claude can
 * write it ("Mail follow-up: Reply… in Gmail makes an empty draft: have Claude
 * write it from the Item, your points and the conversation", issue 1730): one
 * optional line of what Claude should say, with **Draft with Claude**, **Write
 * it myself** and Cancel.
 *
 * - **Empty every time it opens**: the points typed for one draft are not kept
 *   for the next.
 * - **Write it myself is disabled once anything is typed**, so typed points are
 *   never thrown away by pressing the wrong one; clearing the box enables it.
 * - **The press that answers opens the draft's tab**, in that press, so no
 *   pop-up blocker refuses it (`draftAsk.ts`).
 */
export function DraftAsk() {
  const question = useDraftQuestion();
  // A box taken away cannot be answered, and the click waiting on it would wait for ever.
  useEffect(() => cancelDraftQuestion, []);
  return question ? <Box key={question.id} question={question} /> : null;
}

/** A new tab, opened by the press that answers, whose page gets no hold on this one. */
function aTab(): Window | null {
  const tab = window.open('', '_blank');
  if (tab) tab.opener = null;
  return tab;
}

function Box({ question }: { question: Asking }) {
  const [points, setPoints] = useState('');
  const typed = points.trim() !== '';
  const answer = (choice: DraftAnswer | null) => question.answer(choice && { ...choice, tab: aTab() });
  return (
    <Dialog.Root open onOpenChange={(open) => !open && question.answer(null)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-floating bg-scrim/30" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed z-floating left-1/2 top-[calc(1rem_+_var(--edge-top))] w-[min(35rem,calc(100vw-2rem))] -translate-x-1/2 rounded-lg border border-shade/10 bg-surface p-5 shadow-lg md:top-1/2 md:-translate-y-1/2"
        >
          <p className="truncate pb-3 text-sm text-ink-soft">{question.label}</p>
          <Dialog.Title asChild>
            <label htmlFor="draft-points" className="block text-base font-semibold">
              Anything Claude should say? <span className="font-normal text-ink-soft">(optional)</span>
            </label>
          </Dialog.Title>
          <textarea
            id="draft-points"
            autoFocus
            rows={4}
            maxLength={DRAFT_POINTS_LIMIT}
            value={points}
            onChange={(event) => setPoints(event.target.value)}
            placeholder="suggest next Monday or Tuesday, only after 8pm"
            // 16px, so iOS Safari does not zoom the page in on the focused box (NameQuestion says why).
            className="mt-3 w-full rounded-md border border-shade/10 bg-surface px-3 py-2 text-base outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft/40"
          />
          <div className="flex items-center justify-end gap-2 pt-5">
            <button
              type="button"
              onClick={() => answer(null)}
              className="mr-auto shrink-0 rounded-md px-3 py-1.5 text-sm text-ink-soft hover:bg-accent-tint hover:text-accent-deep"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={typed}
              title={typed ? 'Clear what you typed to write it yourself' : undefined}
              onClick={() => answer({ mode: 'self' })}
              className="shrink-0 rounded-md border border-shade/10 px-3 py-1.5 text-sm text-ink-soft hover:bg-accent-tint hover:text-accent-deep disabled:opacity-40 disabled:hover:bg-transparent"
            >
              Write it myself
            </button>
            <button
              type="button"
              onClick={() => answer({ mode: 'claude', points })}
              className="milled shrink-0 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover"
            >
              Draft with Claude
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
