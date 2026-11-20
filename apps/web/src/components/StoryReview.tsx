import { useState } from 'react';
import { uuidv7, type Item } from '@cockpit/shared';
import { useSendCommand } from '../api/queries';

/**
 * *Claude has a new version: Review* ("Keep its story up to date", issue
 * 1827): shown on the form of an Item whose description is yours and which
 * Claude rewrote from the Items it holds. *Review* opens what Claude wrote, and
 * *Use it* makes it the description, while *Keep mine* drops it and leaves the
 * description as it is. Either answers the notice for every tab.
 */
export function StoryReview({
  workspaceId,
  item,
  onUsed,
}: {
  workspaceId: string;
  item: Pick<Item, 'id' | 'storyProposal'>;
  /** Called with the text once *Use it* was accepted, for the form's boxes to show it. */
  onUsed: (story: string) => void;
}) {
  const send = useSendCommand();
  const [open, setOpen] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const proposal = item.storyProposal;
  if (!proposal) return null;

  const answer = async (name: 'use_story' | 'keep_my_story') => {
    setRefusal(null);
    try {
      const result = await send({ name, payload: { commandId: uuidv7(), issuedAt: new Date().toISOString(), workspaceId, itemId: item.id, story: proposal } });
      // Answered already elsewhere, or replaced by a newer one: what is on screen was not stored, so the boxes are not filled with it.
      if (name === 'use_story' && result.applied) onUsed(proposal);
      setOpen(false);
    } catch (failure) {
      setRefusal(failure instanceof Error ? failure.message : 'That could not be saved');
    }
  };
  const button = 'rounded-md border border-shade/15 px-2.5 py-1 text-sm hover:bg-row-hover';

  return (
    <div role="region" aria-label="Claude has a new version" className="mt-3 shrink-0 rounded-md border border-accent-soft/40 bg-accent-tint/50 p-3">
      <p className="text-sm">
        Claude has a new version of this description:{' '}
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="text-accent-deep underline">
          Review
        </button>
      </p>
      {open && (
        <>
          <p className="mt-2 max-h-48 overflow-y-auto rounded-md bg-field p-2 text-sm whitespace-pre-wrap">{proposal}</p>
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={() => void answer('use_story')} className={button}>
              Use it
            </button>
            <button type="button" onClick={() => void answer('keep_my_story')} className={button}>
              Keep mine
            </button>
          </div>
        </>
      )}
      {refusal && (
        <p role="alert" className="pt-1 text-sm text-over-ink">
          {refusal}
        </p>
      )}
    </div>
  );
}
