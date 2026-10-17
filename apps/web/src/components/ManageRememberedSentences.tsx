import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ACCOUNT_WIDE, REMEMBERED_SENTENCE_LIMIT, uuidv7, type RememberedSentenceView } from '@cockpit/shared';
import { CommandRefused } from '../api/client';
import { useSendCommand } from '../api/queries';
import { rememberedSentencesQuery } from '../rememberedSentences';
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
 */
export default function ManageRememberedSentences({ focus }: { focus?: string | undefined }) {
  const { data, error, refetch, isFetching } = useQuery(rememberedSentencesQuery);
  const queryClient = useQueryClient();
  const send = useSendCommand();
  const [editing, setEditing] = useState<string | null>(focus ?? null);
  const [draft, setDraft] = useState('');
  const [asking, setAsking] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const askedFrom = useRef<HTMLElement | null>(null);

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

  const run = async (work: () => Promise<unknown>, done: () => void) => {
    setWorking(true);
    setRefusal(null);
    try {
      await work();
    } catch (failure) {
      setRefusal(failure instanceof CommandRefused ? failure.message : 'That did not reach the server. Try again.');
      setWorking(false);
      return;
    }
    await queryClient.invalidateQueries({ queryKey: rememberedSentencesQuery.queryKey });
    setWorking(false);
    done();
  };

  const save = (one: RememberedSentenceView) =>
    run(
      () =>
        send({
          name: 'edit_remembered_sentence',
          payload: {
            commandId: uuidv7(),
            issuedAt: new Date().toISOString(),
            workspaceId: ACCOUNT_WIDE,
            sentenceId: one.id,
            sentence: draft.trim(),
          },
        }),
      () => setEditing(null),
    );

  const forget = (one: RememberedSentenceView) =>
    run(
      () =>
        send({
          name: 'delete_remembered_sentence',
          payload: { commandId: uuidv7(), issuedAt: new Date().toISOString(), workspaceId: ACCOUNT_WIDE, sentenceId: one.id },
        }),
      () => setAsking(null),
    );

  return (
    <ManageWindow title="What Cockpit remembers" open onClose={() => undefined} canClose={!working}>
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
                    void save(one);
                  }}
                >
                  <label className="block text-sm text-ink-soft">
                    Sentence
                    <textarea
                      autoFocus
                      value={draft}
                      disabled={working}
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
                      disabled={working}
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
                      disabled={working || draft.trim() === ''}
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
            canConfirm={!working}
            refusal={refusal}
            returnFocusTo={askedFrom.current}
            onCancel={() => {
              setAsking(null);
              setRefusal(null);
            }}
            onConfirm={() => void forget(beingAsked)}
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
      <CloseWindow disabled={working} />
    </ManageWindow>
  );
}
