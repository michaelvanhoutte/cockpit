import { Component, Suspense, lazy, useState, type ReactNode } from 'react';

/**
 * The description on the Item's form: a formatted editor over Markdown, with
 * the Markdown itself one button away.
 *
 * **This component is the async boundary the budget requires.** The editor is
 * 135KB compressed against a 200KB gate the entry already spends 173KB of
 * (architecture, "Performance budgets"), so it is fetched only once a form is
 * open and never on the cold-open path. Everything here - the states, the
 * toggle, the fallback - exists because that fetch can be slow, and can fail.
 *
 * **The Markdown is what is stored, and the source view is what is stored.**
 * Not what the editor would re-print: the two differ until something is typed,
 * because parsing and re-printing normalises (`- ` becomes `* `, a table gets
 * padded). Showing the re-printed text would mean opening a form, touching
 * nothing, and finding the description had changed.
 */
const RichDescription = lazy(() => import('../description/RichDescription'));

/** Which of the two views is being shown, and why. */
type View = 'formatted' | 'source';

export interface DescriptionBoxProps {
  value: string;
  onChange: (markdown: string) => void;
  /** False while a save is in flight, when neither view may take a keystroke. */
  editable: boolean;
}

export function DescriptionBox({ value, onChange, editable }: DescriptionBoxProps) {
  const [view, setView] = useState<View>('formatted');
  const [failed, setFailed] = useState(false);
  /**
   * Bumped on the way back from the source view, so the editor is rebuilt from
   * the Markdown as it now reads. Milkdown owns its document once it is made -
   * feeding a new value into the same editor would fight whoever is typing.
   */
  const [generation, setGeneration] = useState(0);

  const showing: View = failed ? 'source' : view;

  return (
    <div className="mt-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
          Description
        </span>
        {!failed && (
          <button
            type="button"
            onClick={() => {
              if (view === 'source') setGeneration((was) => was + 1);
              setView(view === 'formatted' ? 'source' : 'formatted');
            }}
            className="rounded px-2 py-0.5 text-xs font-medium text-ink-soft hover:bg-accent-tint hover:text-accent-deep"
          >
            {view === 'formatted' ? 'Source' : 'Formatted'}
          </button>
        )}
      </div>

      {showing === 'source' ? (
        <textarea
          rows={12}
          aria-label="Description"
          disabled={!editable}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="mt-1 w-full resize-y rounded-md border border-black/10 bg-white px-3 py-2 font-mono text-sm font-normal normal-case tracking-normal text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft/40"
        />
      ) : (
        <WhateverTheEditorDoes onFailure={() => setFailed(true)}>
          <Suspense fallback={<Arriving value={value} />}>
            <RichDescription
              key={generation}
              initial={value}
              onChange={onChange}
              editable={editable}
            />
          </Suspense>
        </WhateverTheEditorDoes>
      )}

      {failed && (
        <p role="alert" className="mt-1 text-xs font-normal normal-case tracking-normal text-over">
          Formatting could not be loaded. The description is still here, as Markdown, and still
          saves.
        </p>
      )}
    </div>
  );
}

/**
 * The description while its editor is on the way: readable, and not yet
 * editable. Read-only rather than a working box, so the cursor is never taken
 * out of someone's hands by the editor arriving under it.
 */
function Arriving({ value }: { value: string }) {
  return (
    <div className="mt-1">
      <textarea
        rows={12}
        readOnly
        aria-label="Description"
        value={value}
        className="w-full resize-y rounded-md border border-black/10 bg-black/5 px-3 py-2 font-mono text-sm font-normal normal-case tracking-normal text-ink-soft outline-none"
      />
      {/* A status rather than a paragraph: it is a live region, so a screen
          reader is told the editor arrived rather than having to go and look. */}
      <p
        role="status"
        className="pt-1 text-xs font-normal normal-case tracking-normal text-ink-faint"
      >
        Formatting is on its way…
      </p>
    </div>
  );
}

/**
 * What happens when the chunk does not arrive - an offline cold open, a deploy
 * that moved the file out from under a stale service worker. Without this the
 * whole form goes down with it and the description is unreachable, which is the
 * one thing the split was not allowed to cost.
 *
 * A class, because a boundary is still the only thing in React that can catch a
 * render failure.
 */
class WhateverTheEditorDoes extends Component<
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
    return this.state.broken ? null : this.props.children;
  }
}
