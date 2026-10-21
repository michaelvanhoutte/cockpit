import { ACCOUNT_WIDE, type RememberedSentenceList } from '@cockpit/shared';
import type { Drawn } from './drawnAhead';

/**
 * What the list of remembered sentences shows of a change the server has not
 * answered yet, or has answered and no read of the list has landed since ("Show
 * a remembered-sentence change the moment you make it", issue 1370).
 *
 * **The list as the server sent it, with the change applied to a copy**, as
 * `connectionsDrawnAhead.ts` does for connections: the held list is never
 * written to, so a read in flight cannot flip the screen back. It lives in the
 * list's own chunk, since nothing else draws a sentence.
 *
 * - **Remember:** the sentence is first in the list, as the newest is, unused,
 *   and for the Workspace it names (`nameOf`). One already there is left alone.
 * - **Edit:** the row has the new words, as one line, as the server keeps them.
 * - **Delete:** the row is gone.
 *
 * A change the server will refuse is drawn all the same until the refusal puts
 * the list back.
 */
export function sentencesDrawnOver(
  nameOf: (workspaceId: string) => string | undefined,
): (list: RememberedSentenceList, changes: readonly Drawn[]) => RememberedSentenceList {
  const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
  return (list, changes) =>
    changes.reduce((held, change) => {
      switch (change.name) {
        case 'remember_sentence': {
          const { sentenceId: id, sentence, action, sourceKind, workspaceId, issuedAt } = change.payload;
          if (held.sentences.some((one) => one.id === id)) return held;
          const named = workspaceId === ACCOUNT_WIDE ? null : workspaceId;
          const kept = {
            id,
            sentence: oneLine(sentence),
            action: oneLine(action),
            sourceKind,
            workspaceId: named,
            workspaceName: named === null ? null : (nameOf(named) ?? null),
            useCount: 0,
            lastUsedAt: null,
            createdAt: issuedAt,
          };
          return { sentences: [kept, ...held.sentences] };
        }
        case 'edit_remembered_sentence': {
          const { sentenceId: id, sentence } = change.payload;
          return { sentences: held.sentences.map((one) => (one.id === id ? { ...one, sentence: oneLine(sentence) } : one)) };
        }
        case 'delete_remembered_sentence':
          return { sentences: held.sentences.filter((one) => one.id !== change.payload.sentenceId) };
        default:
          return held;
      }
    }, list);
}
