import { Component, Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { uuidv7 } from '@cockpit/shared';
import type { Panel } from '@cockpit/shared';
import { refusalFrom, useCommand } from '../api/queries';
import { NOTHING_WRITTEN_HERE, WRITE_HERE } from '../whatThingsAre';

/**
 * What a panel of text holds: prose, written straight onto the dashboard
 * ("Put a panel of text on a dashboard, and write in it", issue 250), drawn as
 * the characters that were typed or as what they mean ("Format what a panel
 * says, without making every dashboard pay for an editor", issue 251).
 *
 * **Four states out of two answers, and only two of them fetch anything:**
 *
 * | | read-only | written in |
 * |---|---|---|
 * | **plain** | the characters, as stored | a box |
 * | **rich** | the words, drawn (`DrawnText`) | the editor |
 *
 * Both defaults are the free corner, which is what answers the performance
 * budget `docs/ideas.md` raised against this feature: a dashboard of panels of
 * text costs nothing to open, only a panel somebody has formatted fetches a
 * renderer, and only one they are writing in formatted fetches an editor.
 *
 * **Nothing is saved on a keystroke.** Every box here reports as it is typed
 * in; this keeps the latest and sends one change once the typing stops, and
 * again on the way out - so a panel left mid-sentence is saved rather than
 * losing the sentence to a timer that never fired.
 *
 * **What is sent is the whole text**, which is what makes the same change sent
 * twice land once and two people typing at once end with the later one's words
 * rather than a merge nobody asked for (`setPanelTextSchema`).
 */

/** Writing formatted text: the editor the item form's description carries. */
const RichDescription = lazy(() => import('../description/RichDescription'));
/** Reading it: a fraction of the size, which is why it is a chunk of its own. */
const DrawnText = lazy(() => import('./DrawnText'));

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
   * That a chunk did not arrive - an offline cold open, a deploy that moved the
   * file out from under a stale service worker. Without somewhere to fall back
   * to, the panel would be blank and what is in it unreachable; the characters
   * are the same characters either way, so they are what is left.
   */
  const [failed, setFailed] = useState(false);

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
  const formatted = panel.format === 'rich' && !failed;

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
      {panel.readOnly ? (
        <Reading panel={panel} formatted={formatted} onFailure={() => setFailed(true)} />
      ) : (
        <Writing
          panel={panel}
          formatted={formatted}
          onChange={changed}
          onFailure={() => setFailed(true)}
        />
      )}
    </div>
  );
}

/** A panel being read: the words as they were typed, or as what they say. */
function Reading({
  panel,
  formatted,
  onFailure,
}: {
  panel: Panel;
  formatted: boolean;
  onFailure: () => void;
}) {
  if (!panel.body) {
    return <p className="px-4 py-3 text-sm text-ink-faint">{NOTHING_WRITTEN_HERE}</p>;
  }
  if (!formatted) return <AsTyped body={panel.body} />;
  return (
    <WhateverTheChunkDoes onFailure={onFailure}>
      <Suspense fallback={<AsTyped body={panel.body} />}>
        <DrawnText body={panel.body} />
      </Suspense>
    </WhateverTheChunkDoes>
  );
}

/**
 * A panel being written in: a plain box, or the editor.
 *
 * **The editor's toolbar is drawn only while somebody is writing in this
 * panel.** A formatting bar standing over a dashboard the rest of the time is
 * chrome for something nobody is doing, and a dashboard of formatted panels
 * would be a screen of them.
 */
function Writing({
  panel,
  formatted,
  onChange,
  onFailure,
}: {
  panel: Panel;
  formatted: boolean;
  onChange: (body: string) => void;
  onFailure: () => void;
}) {
  /**
   * Whether somebody is writing in this panel *now*.
   *
   * **State rather than `:focus-within`**, because the bar has to survive its
   * own controls: pressing bold moves the focus to a button and typing a link's
   * address moves it to a field, both inside this box, and both pass through a
   * moment with the focus nowhere. The blur is deferred a tick so the two
   * halves of that move settle before it is read.
   */
  const [writing, setWriting] = useState(false);
  const leaving = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => void (leaving.current && clearTimeout(leaving.current)), []);

  if (!formatted) {
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

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onFocus={() => {
        if (leaving.current) clearTimeout(leaving.current);
        setWriting(true);
      }}
      onBlur={() => {
        if (leaving.current) clearTimeout(leaving.current);
        leaving.current = setTimeout(() => setWriting(false), 0);
      }}
    >
      <WhateverTheChunkDoes onFailure={onFailure}>
        <Suspense fallback={<AsTyped body={panel.body} />}>
          <RichDescription
            // Built once. It takes `toolbar` as it changes, so clicking into
            // the panel and out of it never rebuilds the editor - which would
            // replace what has been typed with what was last stored.
            initial={panel.body}
            onChange={onChange}
            editable
            label={panel.name}
            toolbar={writing}
            fill
          />
        </Suspense>
      </WhateverTheChunkDoes>
    </div>
  );
}

/**
 * The Markdown as it is stored, which is what plain means - and what is left
 * where a chunk is on its way or never came.
 */
function AsTyped({ body }: { body: string }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
      {/* No label of its own: the panel's own region already carries the name,
          and `aria-label` on an element with no role is dropped rather than
          announced. */}
      <pre className="whitespace-pre-wrap font-sans text-sm text-ink">{body}</pre>
    </div>
  );
}

/**
 * What happens when a chunk does not arrive. The same boundary the item form's
 * description carries, and for the same reason: without it the whole board goes
 * down with it, and a class is still the only thing in React that catches a
 * render failure.
 */
class WhateverTheChunkDoes extends Component<
  { children: ReactNode; onFailure: () => void },
  { broken: boolean }
> {
  state = { broken: false };

  static getDerivedStateFromError() {
    return { broken: true };
  }

  componentDidCatch() {
    this.props.onFailure();
  }

  render() {
    // Null for the render that catches; the failure is reported up, and the
    // next render draws the characters instead.
    return this.state.broken ? null : this.props.children;
  }
}
