import { useId, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  PANEL_COLUMN_WIDTHS,
  panelGathers,
  panelHoldsText,
  panelTakesItems,
  type Panel,
  type PanelColumns,
} from '@cockpit/shared';
import { columnsThatFit } from '../panelColumns';

/** What the form changed, and only that: a field left alone is not in it. */
export interface PanelSettingsChanges {
  name?: string;
  neverPropose?: boolean;
  readOnly?: boolean;
  format?: 'plain' | 'rich';
  /** The narrowest a column may be, or null for one list. */
  columns?: PanelColumns | null;
}

/** The widths offered, each with the kind of title it suits. */
const COLUMN_CHOICES: readonly { value: PanelColumns; label: string; suits: string }[] = [
  { value: 'narrow', label: 'Narrow', suits: 'short titles' },
  { value: 'medium', label: 'Medium', suits: 'most panels' },
  { value: 'wide', label: 'Wide', suits: 'long titles' },
];

/** Which kind of Panel this is, said in a line under the title. */
function kindLine(panel: Panel): string {
  if (panelGathers(panel)) {
    return 'A filter panel: it collects items from every panel in this workspace that match its rules.';
  }
  if (panelHoldsText(panel)) return 'A text panel: words written straight onto the dashboard.';
  return 'A panel of items: it holds what you file onto it.';
}

/**
 * A Panel's name and settings, asked in one form ("Change a Panel's name and
 * settings in one Panel settings form", issue 1206).
 *
 * **Save carries only what this form changed**, so a field another tab changed
 * after this one opened is not written back over. Nothing changed closes the
 * form without sending. Cancel and Escape discard everything. Read once when it
 * opens, and keyed on the Panel by the board, for the reasons `SortQuestion` is.
 *
 * Lazy-loaded from `PanelBoard.tsx`, for the reason `FilterQuestion` is.
 */
function PanelSettingsQuestion({
  panel,
  open,
  onSave,
  onCancel,
  refusal,
  busy = false,
  returnFocusTo,
  drawnWidth = null,
}: {
  panel: Panel;
  open: boolean;
  onSave: (changes: PanelSettingsChanges) => void;
  onCancel: () => void;
  refusal?: string | null;
  busy?: boolean;
  returnFocusTo?: HTMLElement | null;
  /** How wide the Panel's list is drawn, in pixels, which is what the columns line is worked out from. */
  drawnWidth?: number | null;
}) {
  const [name, setName] = useState(panel.name);
  const [suggest, setSuggest] = useState(!panel.neverPropose);
  const [readOnly, setReadOnly] = useState(panel.readOnly);
  const [rich, setRich] = useState(panel.format === 'rich');
  const [split, setSplit] = useState(panel.columns !== null);
  const [columnWidth, setColumnWidth] = useState<PanelColumns>(panel.columns ?? 'medium');
  const ids = useId();

  const items = panelTakesItems(panel);
  const text = panelHoldsText(panel);
  const trimmed = name.trim();
  const canSave = !busy && trimmed.length > 0;

  const save = () => {
    if (!canSave) return;
    const changes: PanelSettingsChanges = {};
    if (trimmed !== panel.name) changes.name = trimmed;
    if (items && suggest === panel.neverPropose) changes.neverPropose = !suggest;
    if (text && readOnly !== panel.readOnly) changes.readOnly = readOnly;
    if (text && rich !== (panel.format === 'rich')) changes.format = rich ? 'rich' : 'plain';
    const columns = split ? columnWidth : null;
    if (!text && columns !== panel.columns) changes.columns = columns;
    if (Object.keys(changes).length === 0) onCancel();
    else onSave(changes);
  };

  return (
    <Dialog.Root open={open} onOpenChange={(nowOpen) => !nowOpen && !busy && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-floating bg-scrim/30" />
        <Dialog.Content
          onCloseAutoFocus={(event) => {
            if (!returnFocusTo) return;
            event.preventDefault();
            returnFocusTo.focus();
          }}
          className="fixed z-floating left-1/2 top-[calc(1rem_+_var(--edge-top))] w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 rounded-lg border border-shade/10 bg-surface p-5 shadow-lg md:top-1/2 md:-translate-y-1/2"
        >
          <Dialog.Title className="text-base font-semibold">Panel settings</Dialog.Title>
          <Dialog.Description className="pt-2 text-sm text-ink-soft">
            {kindLine(panel)}
          </Dialog.Description>

          <form
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
            className="flex flex-col gap-5 pt-4"
          >
            <section aria-labelledby={`${ids}-name`}>
              <h3
                id={`${ids}-name`}
                className="text-xs font-semibold uppercase tracking-[0.11em] text-accent-deep"
              >
                Name
              </h3>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                aria-label="Name"
                maxLength={60}
                autoFocus
                className="mt-2 w-full rounded-md border border-shade/10 bg-surface px-2 py-1.5 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft/40"
              />
            </section>

            {items && (
              <section aria-labelledby={`${ids}-inbox`}>
                <h3
                  id={`${ids}-inbox`}
                  className="text-xs font-semibold uppercase tracking-[0.11em] text-accent-deep"
                >
                  Inbox suggestions
                </h3>
                <Setting
                  checked={suggest}
                  onChange={setSuggest}
                  label={`Suggest ${panel.name} for new items in the Inbox`}
                  hint="Untick for a panel you file into alongside another, like a Next up, so it doesn't attract everything."
                />
              </section>
            )}

            {!text && (
              <section aria-labelledby={`${ids}-look`}>
                <h3
                  id={`${ids}-look`}
                  className="text-xs font-semibold uppercase tracking-[0.11em] text-accent-deep"
                >
                  How it looks
                </h3>
                <fieldset className="mt-2 text-sm">
                  <legend className="pb-1 text-ink-soft">When the panel is wide enough</legend>
                  <Choice name={`${ids}-split`} checked={!split} onChange={() => setSplit(false)} label="Keep one list" />
                  <Choice
                    name={`${ids}-split`}
                    checked={split}
                    onChange={() => setSplit(true)}
                    label="Split into columns"
                  />
                </fieldset>
                {split && (
                  <fieldset className="mt-3 text-sm">
                    <legend className="pb-1 text-ink-soft">Make each column at least</legend>
                    {COLUMN_CHOICES.map((choice) => (
                      <Choice
                        key={choice.value}
                        name={`${ids}-width`}
                        checked={columnWidth === choice.value}
                        onChange={() => setColumnWidth(choice.value)}
                        label={choice.label}
                        hint={choice.suits}
                      />
                    ))}
                    {drawnWidth !== null && (
                      <p className="pt-2 text-xs text-ink-faint">
                        {(() => {
                          const n = columnsThatFit(drawnWidth, PANEL_COLUMN_WIDTHS[columnWidth]);
                          return `Here that gives ${n} ${n === 1 ? 'column' : 'columns'}. Fewer on a smaller screen, one on a phone.`;
                        })()}
                      </p>
                    )}
                  </fieldset>
                )}
              </section>
            )}

            {text && (
              <section aria-labelledby={`${ids}-text`}>
                <h3
                  id={`${ids}-text`}
                  className="text-xs font-semibold uppercase tracking-[0.11em] text-accent-deep"
                >
                  Text
                </h3>
                <div className="flex flex-col gap-3">
                  <Setting
                    checked={readOnly}
                    onChange={setReadOnly}
                    label="Read-only"
                    hint="The words can be read but not typed into, until you untick this."
                  />
                  <Setting
                    checked={rich}
                    onChange={setRich}
                    label="Show formatting"
                    hint="Draw the words as they are meant: headings, bold and lists. Unticked, you see the characters typed."
                  />
                </div>
              </section>
            )}

            {refusal && (
              <p role="alert" className="text-sm text-over-ink">
                {refusal}
              </p>
            )}

            <div className="flex justify-end gap-2">
              <Dialog.Close
                disabled={busy}
                className="shrink-0 rounded-md border border-shade/10 px-3 py-1.5 text-sm text-ink-soft hover:bg-accent-tint hover:text-accent-deep disabled:opacity-50"
              >
                Cancel
              </Dialog.Close>
              <button
                type="submit"
                disabled={!canSave}
                className="milled shrink-0 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
              >
                Save
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Choice({
  name,
  checked,
  onChange,
  label,
  hint,
}: {
  name: string;
  checked: boolean;
  onChange: () => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="flex items-center gap-2 py-0.5">
      <input type="radio" name={name} checked={checked} onChange={onChange} />
      {label}
      {hint && <span className="text-xs text-ink-faint">{hint}</span>}
    </label>
  );
}

function Setting({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  hint: string;
}) {
  const hintId = useId();
  return (
    <div className="mt-2 text-sm">
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
          aria-describedby={hintId}
        />
        {label}
      </label>
      <p id={hintId} className="pl-6 pt-0.5 text-xs text-ink-faint">
        {hint}
      </p>
    </div>
  );
}

export default PanelSettingsQuestion;
