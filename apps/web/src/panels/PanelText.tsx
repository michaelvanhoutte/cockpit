import { useCallback, useEffect, useRef } from 'react';
import { uuidv7 } from '@cockpit/shared';
import type { Panel } from '@cockpit/shared';
import { refusalFrom, useCommand } from '../api/queries';
import { NOTHING_WRITTEN_HERE, WRITE_HERE } from '../whatThingsAre';

/**
 * What a panel of text holds: prose, written straight onto the dashboard
 * ("Put a panel of text on a dashboard, and write in it", issue 250).
 *
 * **Nothing is saved on a keystroke.** The box reports every change as it
 * happens; this keeps the latest and sends one change once the typing stops,
 * and again on the way out - so a panel left mid-sentence is saved rather than
 * losing the sentence to a timer that never fired.
 *
 * **What is sent is the whole text**, which is what makes the same change sent
 * twice land once and two people typing at once end with the later one's words
 * rather than a merge nobody asked for (`setPanelTextSchema`).
 */

/**
 * How long the typing has to stop before what is there is sent.
 *
 * **Each send costs a re-read of the whole workspace**, because that is what
 * every change costs (`afterChanging` in api/queries.ts): the snapshot is one
 * answer covering every item, panel and layout, and the tab that made a change
 * does not wait for its own message to come back down the stream. So this is
 * the number that decides how often a person writing a paragraph re-reads the
 * workspace, and it is why the box is not saved on a keystroke.
 */
export const QUIET = 700;

export function PanelText({ panel, workspaceId }: { panel: Panel; workspaceId: string }) {
  const command = useCommand();

  /**
   * What was typed and has not been sent, and the timer that will send it.
   *
   * Refs rather than state: neither is drawn, and putting the keystroke in
   * state would re-render the panel on every letter to show exactly what the
   * box already shows.
   */
  const pending = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const save = useCallback(
    (body: string) => {
      pending.current = null;
      command.mutate({
        name: 'set_panel_text',
        payload: {
          commandId: uuidv7(),
          issuedAt: new Date().toISOString(),
          workspaceId,
          panelId: panel.id,
          body,
        },
      });
    },
    // `command` is rebuilt every render and `mutate` is stable on it; naming the
    // whole object here would rebuild `save`, and with it the effect below that
    // sends what is unsent on the way out.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [command.mutate, workspaceId, panel.id],
  );

  const changed = (body: string) => {
    pending.current = body;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => save(body), QUIET);
  };

  /**
   * What is unsent, sent on the way out. Switching dashboard unmounts the
   * panel, and a timer that has not fired yet would take the last sentence with
   * it - which is the case somebody notices only once the words are gone.
   */
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      if (pending.current !== null) save(pending.current);
    },
    [save],
  );

  const refusal = refusalFrom(command);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Above the text rather than instead of it, the way a panel's other
          refusals are drawn: a change that did not reach the server says so
          without taking away what somebody has typed. */}
      {refusal && (
        <p role="alert" className="px-4 pt-3 text-sm text-over">
          {refusal}
        </p>
      )}
      {panel.readOnly ? <Reading panel={panel} /> : <Writing panel={panel} onChange={changed} />}
    </div>
  );
}

/**
 * A panel being read: the text as it was typed.
 *
 * `pre` rather than paragraphs, because what is stored is Markdown and this
 * issue draws the characters rather than what they mean - so the line breaks
 * somebody put in are the shape of what they wrote, and `whitespace-pre-wrap`
 * is what keeps them without letting a long line push the panel sideways.
 */
function Reading({ panel }: { panel: Panel }) {
  if (!panel.body) {
    return <p className="px-4 py-3 text-sm text-ink-faint">{NOTHING_WRITTEN_HERE}</p>;
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
      {/* No label of its own: the panel's own region already carries the name,
          and `aria-label` on an element with no role is dropped rather than
          announced - so a second one here would read as labelling that works
          and would not. */}
      <pre className="whitespace-pre-wrap font-sans text-sm text-ink">
        {panel.body}
      </pre>
    </div>
  );
}

/**
 * A panel being written in.
 *
 * **`defaultValue`, so the box is the author's once it is open.** A controlled
 * box fed from the snapshot would be rewritten by every re-read that lands
 * while somebody is typing - and the snapshot is re-read on every save, so that
 * is every pause. The text that arrives from elsewhere is taken when the panel
 * is next read, which is what `Reading` above draws.
 */
function Writing({ panel, onChange }: { panel: Panel; onChange: (body: string) => void }) {
  return (
    <textarea
      aria-label={panel.name}
      defaultValue={panel.body}
      onChange={(event) => onChange(event.target.value)}
      placeholder={WRITE_HERE}
      // No resize handle: the panel's height is its row's, and a box that could
      // be dragged taller inside it would be a second answer to a question the
      // row has already answered.
      className="min-h-0 flex-1 resize-none border-0 bg-transparent px-4 py-3 text-sm text-ink outline-none placeholder:text-ink-faint"
    />
  );
}
