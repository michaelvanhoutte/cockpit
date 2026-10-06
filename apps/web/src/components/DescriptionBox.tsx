import { Suspense, useEffect, useRef, useState } from 'react';
import {
  LazyRichDescription,
  NewerVersionIfStale,
  WhateverTheEditorDoes,
} from '../description/lazyEditor';

/**
 * The description on the Item's form: a formatted editor over Markdown, with
 * the Markdown itself one button away.
 *
 * **This component is the async boundary the budget requires.** The editor's
 * own file is 115KB compressed and the Markdown core it shares with a panel's
 * renderer another 21KB, against a 201KB gate the entry already spends 200KB of
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

/** Which of the two views is being shown, and why. */
type View = 'formatted' | 'source';

export interface DescriptionBoxProps {
  value: string;
  onChange: (markdown: string) => void;
  /** False while a save is in flight, when neither view may take a keystroke. */
  editable: boolean;
  /**
   * Changed by the caller to say the editor's value was replaced wholesale
   * rather than typed - a reading chosen for it, not a keystroke into it
   * ("Offer the other readings when a captured note says two things", issue
   * 297) - and folded into the same rebuild `generation` already does for the
   * Source-toggle case below, so the caller need not remount this component
   * itself. Remounting `DescriptionBox` from outside would also throw away
   * `view` and `failed`, which have nothing to do with which text is showing.
   */
  resetKey?: string | number;
  /** Where an image put into the formatted view is uploaded (`RichDescription`). */
  uploadImage?: (file: File) => Promise<string>;
  /**
   * On a phone's page for an Item: no heading, and *Source* in the toolbar's
   * own row, which scrolls sideways, rather than in a line of its own.
   */
  onAPage?: boolean;
}

export function DescriptionBox({ value, onChange, editable, resetKey, uploadImage, onAPage = false }: DescriptionBoxProps) {
  const [view, setView] = useState<View>('formatted');
  const [failed, setFailed] = useState(false);
  /**
   * Bumped on the way back from the source view, and whenever the caller's
   * own `resetKey` changes - both are "the value underneath was replaced
   * wholesale", which is what rebuilds the editor. Milkdown owns its document
   * once it is made - feeding a new value into the same editor would fight
   * whoever is typing.
   */
  const [generation, setGeneration] = useState(0);
  /**
   * Skips the bump `resetKey` would otherwise cause on the very first render,
   * where there is nothing to reset - `resetKey` starting non-`undefined` is
   * the caller's own initial value, not a change.
   */
  const seenResetKey = useRef(resetKey);
  useEffect(() => {
    if (resetKey === seenResetKey.current) return;
    seenResetKey.current = resetKey;
    setGeneration((was) => was + 1);
  }, [resetKey]);

  const showing: View = failed ? 'source' : view;

  const toggle = failed ? null : (
    <button
      type="button"
      onClick={() => {
        if (view === 'source') setGeneration((was) => was + 1);
        setView(view === 'formatted' ? 'source' : 'formatted');
      }}
      className="shrink-0 rounded px-2 py-0.5 text-xs font-medium text-ink-soft hover:bg-accent-tint hover:text-accent-deep"
    >
      {view === 'formatted' ? 'Source' : 'Formatted'}
    </button>
  );
  /** Where the toolbar is not drawn - the source view, and the editor still on its way - *Source* has a row of its own. */
  const rowOfItsOwn = onAPage && toggle && (
    <div className="flex shrink-0 justify-end">{toggle}</div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {onAPage ? (
        showing === 'source' && rowOfItsOwn
      ) : (
        <div className="flex shrink-0 items-center justify-between gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
            Description
          </span>
          {toggle}
        </div>
      )}

      {showing === 'source' ? (
        <textarea
          aria-label="Description"
          disabled={!editable}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          // Fills whatever height the form has rather than a fixed row
          // count, the description's own resize handle having been folded
          // into the dialog's own once the two shared a box ("Give the
          // item's form more room, and put clutter out of the way", issue
          // 480).
          className="mt-1 min-h-0 flex-1 resize-none rounded-md border border-shade/10 bg-white px-3 py-2 font-mono text-sm font-normal normal-case tracking-normal text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft/40"
        />
      ) : (
        // `RichDescription`'s own `fill` skips its usual border/background/
        // focus ring, on the assumption a caller asking for it already sits
        // inside a box of its own - true for `fill`'s other caller,
        // `PanelText`'s own well, and not true here, which left the
        // formatted view boxless while the Source `textarea` right beside it
        // (above) kept its (found in review). Supplied here instead, so
        // `Arriving` below drops the matching border/background it used to
        // carry on its own rather than drawing two.
        <div className="mt-1 flex min-h-0 flex-1 flex-col rounded-md border border-shade/10 bg-white focus-within:border-accent focus-within:ring-2 focus-within:ring-accent-soft/40">
          <WhateverTheEditorDoes onFailure={() => setFailed(true)}>
            <Suspense
              fallback={
                <>
                  {rowOfItsOwn}
                  <Arriving value={value} />
                </>
              }
            >
              <LazyRichDescription
                key={generation}
                initial={value}
                onChange={onChange}
                editable={editable}
                uploadImage={uploadImage}
                endOfToolbar={onAPage ? toggle : undefined}
                fill
              />
            </Suspense>
          </WhateverTheEditorDoes>
        </div>
      )}

      {failed && (
        <p role="alert" className="mt-1 shrink-0 text-xs font-normal normal-case tracking-normal text-over">
          Formatting could not be loaded. The description is still here, as Markdown, and still
          saves.{' '}
          {/* Offered rather than taken, which is the difference between this and
              the gate around the whole window (components/Updating.tsx). That
              one reloads unasked because carrying on is actively wrong - it
              cannot read what the server says. Here carrying on works: the box
              below takes text and saves it, so reloading unasked would trade a
              description somebody is part-way through for a formatting bar. */}
          <NewerVersionIfStale />
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
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Borderless: the formatted view's own box (above) now supplies it,
          which this sits inside of as the `Suspense` fallback - a border
          here too drew two. */}
      <textarea
        readOnly
        aria-label="Description"
        value={value}
        className="min-h-0 flex-1 resize-none rounded-md bg-shade/5 px-3 py-2 font-mono text-sm font-normal normal-case tracking-normal text-ink-soft outline-none"
      />
      {/* A status rather than a paragraph: it is a live region, so a screen
          reader is told the editor arrived rather than having to go and look. */}
      <p
        role="status"
        className="shrink-0 pt-1 text-xs font-normal normal-case tracking-normal text-ink-faint"
      >
        Formatting is on its way…
      </p>
    </div>
  );
}
