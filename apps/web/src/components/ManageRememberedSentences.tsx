import { useEffect, useMemo, useRef, useState } from 'react';
import { ACCOUNT_WIDE, REMEMBERED_SENTENCE_LIMIT, uuidv7, type RememberedSentenceView } from '@cockpit/shared';
import { whyNotDone } from '../api/queries';
import { useChangeSentence, useRememberedSentences } from '../rememberedSentences';
import { useUndo } from '../undo';
import { DeleteQuestion } from './DeleteQuestion';
import { LoadFailure } from './LoadFailure';
import { CloseWindow, ManageWindow } from './ManageWindow';
import { RowMenu } from './Menu';

const when = (iso: string) => new Date(iso).toLocaleDateString();

/** Where a sentence applies, in the words a row says it. */
function appliesTo(one: RememberedSentenceView): string {
  if (one.workspaceId === null) return 'every workspace';
  return one.workspaceName ? `${one.workspaceName} only` : 'a workspace that is gone';
}

function used(one: RememberedSentenceView): string {
  if (one.useCount === 0) return 'not used yet';
  return `used ${one.useCount === 1 ? 'once' : `${one.useCount} times`}, last ${when(one.lastUsedAt ?? one.createdAt)}`;
}

/**
 * The sentences Cockpit remembers from your edits ("See and change what
 * Cockpit remembers", issue 1164): what each says, what it applies to, when it
 * was kept and how often it was used, to reword or delete. **Nothing here
 * adds one** - a sentence is only ever kept from an edit, in the review
 * window. Opened on one sentence, in edit, where the window that used it
 * sent you (`focus`).
 *
 * **A change shows at the click** (issue 1370): a reworded sentence is in its row
 * and a deleted one is gone, with the server still to answer. A reworded one the
 * server refuses comes back to its form with the reason; a deleted one it refuses
 * returns to the list, and the undo bar says why, since the question closed at the click.
 */
export default function ManageRememberedSentences({ focus }: { focus?: string | undefined }) {
  const { data, error, refetch, isFetching } = useRememberedSentences();
  const change = useChangeSentence();
  const offerToUndo = useUndo();
  const [editing, setEditing] = useState<string | null>(focus ?? null);
  const [draft, setDraft] = useState('');
  const [asking, setAsking] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const askedFrom = useRef<HTMLElement | null>(null);
  // Which row is open for rewording *now*, for a refusal that comes back after the person moved on.
  const editingNow = useRef(editing);
  editingNow.current = editing;
  // Whether the window is still open, since it may be closed before a refusal comes back.
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);

  const sentences = useMemo(() => data?.sentences ?? [], [data]);
  const answered = data !== undefined;
  const beingAsked = sentences.find((one) => one.id === asking);

  // Opened for editing from the window that used it: the draft starts as the sentence once it has arrived.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || !focus) return;
    const found = sentences.find((one) => one.id === focus);
    if (!found) return;
    opened.current = true;
    setDraft(found.sentence);
  }, [focus, sentences]);

  /**
   * Rewords at the click: the form closes and the row has the new words at once.
   * Refused, the form comes back with the words typed and the reason, unless the
   * person has opened another row or closed the window meanwhile, and then the
   * undo bar says it.
   */
  const save = (one: RememberedSentenceView) => {
    const words = draft.trim();
    setRefusal(null);
    setEditing(null);
    change({
      name: 'edit_remembered_sentence',
      payload: { commandId: uuidv7(), issuedAt: new Date().toISOString(), workspaceId: ACCOUNT_WIDE, sentenceId: one.id, sentence: words },
    }).catch((failure: unknown) => {
      if (!open.current || editingNow.current !== null) return offerToUndo({ what: `“${one.sentence}” was not reworded. ${whyNotDone(failure)}` });
      setDraft(words);
      setEditing(one.id);
      setRefusal(whyNotDone(failure));
    });
  };

  /** Forgets at the click: the question closes and the row is gone at once. Refused, the row comes back and the undo bar says why. */
  const forget = (one: RememberedSentenceView) => {
    change({
      name: 'delete_remembered_sentence',
      payload: { commandId: uuidv7(), issuedAt: new Date().toISOString(), workspaceId: ACCOUNT_WIDE, sentenceId: one.id },
    }).catch((failure: unknown) => {
      offerToUndo({ what: `“${one.sentence}” was not forgotten. ${whyNotDone(failure)}` });
    });
    setAsking(null);
  };
  return (
    <ManageWindow title="What Cockpit remembers" open onClose={() => undefined}>
      <p className="mt-2 text-sm text-ink-faint">
        Sentences Cockpit kept from your edits. Each shapes what it proposes for the kind of action it applies to.
      </p>
      <section className="-mx-2 mt-3 min-h-0 flex-1 overflow-y-auto">
        <ul>
          {sentences.map((one) => (
            <li key={one.id} className="border-b border-shade/5 px-4 py-2 last:border-b-0">
              {editing === one.id ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (draft.trim() === '' || draft.trim() === one.sentence) return setEditing(null);
                    save(one);
                  }}
                >
                  <label className="block text-sm text-ink-soft">
                    Sentence
                    <textarea
                      autoFocus
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      rows={3}
                      maxLength={REMEMBERED_SENTENCE_LIMIT}
                      className="mt-1 w-full resize-y rounded-md border border-shade/10 bg-field px-3 py-2 text-sm text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft/40"
                    />
                  </label>
                  {refusal && (
                    <p role="alert" className="pt-2 text-sm text-over-ink">
                      {refusal}
                    </p>
                  )}
                  <div className="flex justify-end gap-2 pt-2">
                    <button
                      type="button"
                      onClick={() => {
                        setEditing(null);
                        setRefusal(null);
                      }}
                      className="shrink-0 rounded-md border border-shade/10 px-3 py-1.5 text-sm text-ink-soft hover:bg-accent-tint hover:text-accent-deep disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={draft.trim() === ''}
                      className="milled shrink-0 rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
                    >
                      Save
                    </button>
                  </div>
                </form>
              ) : (
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm">{one.sentence}</p>
                    <p className="text-sm text-ink-faint">
                      For {one.action} · {appliesTo(one)} · kept {when(one.createdAt)} · {used(one)}
                    </p>
                  </div>
                  <RowMenu
                    label={`Actions for “${one.sentence}”`}
                    entries={[
                      {
                        label: 'Edit',
                        onSelect: () => {
                          setRefusal(null);
                          setDraft(one.sentence);
                          setEditing(one.id);
                        },
                      },
                      {
                        label: 'Delete',
                        destructive: true,
                        onSelect: (openedFrom) => {
                          setRefusal(null);
                          askedFrom.current = openedFrom;
                          setAsking(one.id);
                        },
                      },
                    ]}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
        {beingAsked && (
          <DeleteQuestion
            open
            question={`Forget “${beingAsked.sentence}”? Cockpit stops using it in what it proposes.`}
            confirmLabel="Yes, forget this sentence"
            confirmText="Delete"
            returnFocusTo={askedFrom.current}
            onCancel={() => setAsking(null)}
            onConfirm={() => forget(beingAsked)}
          />
        )}
        {Boolean(error) && !answered && (
          <div className="px-4 py-4">
            <LoadFailure error={error} onRetry={() => void refetch()} />
          </div>
        )}
        {answered && sentences.length === 0 && !isFetching && (
          <p className="px-4 py-4 text-sm text-ink-faint">Nothing remembered yet. Edit what Cockpit proposes before you send it, and it offers to keep a sentence.</p>
        )}
      </section>
      <CloseWindow />
    </ManageWindow>
  );
}
