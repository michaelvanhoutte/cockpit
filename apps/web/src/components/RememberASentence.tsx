import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  ACCOUNT_WIDE,
  REMEMBERED_SENTENCE_LIMIT,
  rememberOfferAnswerSchema,
  uuidv7,
  type RememberOffer,
} from '@cockpit/shared';
import { CommandRefused, api } from '../api/client';
import { useSendCommand } from '../api/queries';

/**
 * How long the offer is waited for. The server gives up on the model after 20
 * seconds and answers no offer; this is only for a server that does not answer
 * at all, and ends the same way, with nothing asked and nothing lost.
 */
const OFFER_WAITED_FOR_MS = 25_000;

/** The offer for a send, or null where there is none for any reason: a request that fails is no offer. */
async function fetchOffer(runId: string, signal: AbortSignal): Promise<RememberOffer | null> {
  try {
    const res = await api.v1['claude-sends'][':runId']['remember-offer'].$post({ param: { runId } }, { init: { signal } });
    if (!res.ok) return null;
    return rememberOfferAnswerSchema.parse(await res.json()).offer;
  } catch {
    return null;
  }
}

/**
 * What the window shows after Open, for an edit ("Remember an edit as a
 * sentence you confirm", issue 1163): Claude has been opened already, so this
 * waits for the offer without holding anything up, and **closes the window
 * itself where there is none**. Where there is one it is a sentence to reword,
 * keep with *Remember*, or drop with *Just this once*; closing the window any
 * other way keeps nothing. Nothing is remembered without that press.
 */
export function RememberASentence({
  runId,
  workspaceId,
  destinationName,
  onClose,
}: {
  runId: string;
  workspaceId: string;
  destinationName: string;
  onClose: () => void;
}) {
  const send = useSendCommand();
  const [offer, setOffer] = useState<RememberOffer | null>(null);
  const [sentence, setSentence] = useState('');
  const [keeping, setKeeping] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  // One id for this offer: Remember pressed twice is one sentence.
  const [sentenceId] = useState(() => uuidv7());

  // Asked once however many times React runs the effect: a second ask would be a second call to the model.
  const asked = useRef<Promise<RememberOffer | null> | null>(null);

  useEffect(() => {
    // Set once this effect is cleaned up, so an answer for a window that has
    // gone closes nothing.
    let gone = false;
    asked.current ??= fetchOffer(runId, AbortSignal.timeout(OFFER_WAITED_FOR_MS));
    void asked.current.then((found) => {
      if (gone) return;
      if (found === null) return onClose();
      setOffer(found);
      setSentence(found.sentence);
    });
    return () => {
      gone = true;
    };
    // Asked once, for this send.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  const remember = async () => {
    if (!offer || keeping || sentence.trim() === '') return;
    setKeeping(true);
    setRefusal(null);
    try {
      await send({
        name: 'remember_sentence',
        payload: {
          commandId: uuidv7(),
          issuedAt: new Date().toISOString(),
          workspaceId: offer.workspaceId ?? ACCOUNT_WIDE,
          sentenceId,
          sentence: sentence.trim(),
          action: offer.action,
          sourceKind: offer.sourceKind,
        },
      });
    } catch (failure) {
      setRefusal(failure instanceof CommandRefused ? failure.message : 'That did not reach the server. Try again.');
      setKeeping(false);
      return;
    }
    onClose();
  };

  if (!offer) {
    return (
      <div role="status" className="mt-4 text-sm text-ink-soft">
        <p>Opened in {destinationName}.</p>
        <p className="mt-1 text-ink-faint">Looking at what you changed…</p>
        <div className="flex justify-end pt-5">
          <Dialog.Close
            type="button"
            className="shrink-0 rounded-md border border-shade/10 px-3 py-1.5 text-sm text-ink-soft hover:bg-accent-tint hover:text-accent-deep"
          >
            Close
          </Dialog.Close>
        </div>
      </div>
    );
  }

  return (
    <form
      className="mt-4"
      onSubmit={(event) => {
        event.preventDefault();
        void remember();
      }}
    >
      <p className="text-sm text-ink-soft">Opened in {destinationName}. You changed what Cockpit proposed.</p>
      <label className="mt-4 block text-sm font-medium text-ink">
        Remember this?
        <textarea
          autoFocus
          value={sentence}
          disabled={keeping}
          onChange={(event) => setSentence(event.target.value)}
          rows={3}
          maxLength={REMEMBERED_SENTENCE_LIMIT}
          className="mt-1 w-full resize-y rounded-md border border-shade/10 bg-field px-3 py-2 text-sm font-normal text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft/40"
        />
      </label>
      <p className="mt-2 text-sm text-ink-faint">
        For: {offer.action} · {offer.workspaceName ? `in ${offer.workspaceName} only` : 'in every workspace'}. It shapes what Cockpit proposes
        from now on.
      </p>

      {refusal && (
        <p role="alert" className="pt-3 text-sm text-over-ink">
          {refusal}
        </p>
      )}

      <div className="flex justify-end gap-2 pt-5">
        <button
          type="button"
          disabled={keeping}
          onClick={onClose}
          className="shrink-0 rounded-md border border-shade/10 px-3 py-1.5 text-sm text-ink-soft hover:bg-accent-tint hover:text-accent-deep disabled:opacity-50"
        >
          Just this once
        </button>
        <button
          type="submit"
          disabled={keeping || sentence.trim() === ''}
          className="milled shrink-0 rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
        >
          Remember
        </button>
      </div>
    </form>
  );
}
