import { useId, useState, type ReactNode } from 'react';
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
 * settings in one Panel settings form", issue 1206), drawn as the throwaway POC
 * that was approved on screen before it was scoped.
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
  const fits = drawnWidth === null ? null : columnsThatFit(drawnWidth, PANEL_COLUMN_WIDTHS[columnWidth]);

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
          className="fixed z-floating left-1/2 top-[calc(1rem_+_var(--edge-top))] max-h-[calc(100dvh-2rem)] w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 overflow-y-auto rounded-lg border border-shade/10 bg-surface p-6 shadow-lg md:top-1/2 md:-translate-y-1/2"
        >
          <Dialog.Title className="text-base font-semibold">Panel settings</Dialog.Title>
          <Dialog.Description className="pt-1 text-sm text-ink-soft">{kindLine(panel)}</Dialog.Description>

          <form
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
            className="flex flex-col gap-5 pt-5 text-sm"
          >
            <section aria-labelledby={`${ids}-name`} className="flex flex-col gap-1.5">
              <Heading id={`${ids}-name`}>Name</Heading>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                aria-label="Name"
                maxLength={60}
                autoFocus
                className="rounded-md border border-shade/15 bg-surface px-2.5 py-2 outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft/40"
              />
            </section>

            {!text && (
              <Section id={`${ids}-look`} title="How it looks">
                <fieldset className="flex flex-col gap-2.5">
                  <legend className="pb-2.5 text-ink-soft">When the panel is wide enough</legend>
                  <Choice
                    type="radio"
                    name={`${ids}-split`}
                    checked={!split}
                    onChange={() => setSplit(false)}
                    label="Keep one list"
                    hint="Every item on its own full-width line"
                  />
                  <Choice
                    type="radio"
                    name={`${ids}-split`}
                    checked={split}
                    onChange={() => setSplit(true)}
                    label="Split into columns"
                    hint="Items read left to right, then down"
                  />
                </fieldset>
                {split && (
                  <fieldset className="ml-6 flex flex-col gap-1.5">
                    <legend className="pb-1.5 text-ink-soft">Make each column at least</legend>
                    <div className="grid grid-cols-3 gap-1.5">
                      {COLUMN_CHOICES.map((choice) => (
                        <label key={choice.value} className="relative cursor-pointer">
                          <input
                            type="radio"
                            name={`${ids}-width`}
                            checked={columnWidth === choice.value}
                            onChange={() => setColumnWidth(choice.value)}
                            aria-describedby={`${ids}-${choice.value}`}
                            className="peer sr-only"
                          />
                          <span className="flex flex-col items-center rounded-md border border-shade/15 px-2 py-1.5 peer-checked:border-accent peer-checked:bg-accent-tint peer-checked:font-medium peer-focus-visible:ring-2 peer-focus-visible:ring-accent-soft/40">
                            {choice.label}
                            <span id={`${ids}-${choice.value}`} className="text-[11px] font-normal text-ink-faint">
                              {choice.suits}
                            </span>
                          </span>
                        </label>
                      ))}
                    </div>
                    {fits !== null && (
                      <p className="text-xs text-ink-faint">
                        Here that gives{' '}
                        <span className="font-medium text-ink">
                          {fits === 1 ? 'one column' : `${fits} columns`}
                        </span>
                        . Fewer on a smaller screen, one on a phone.
                      </p>
                    )}
                  </fieldset>
                )}
              </Section>
            )}

            {items && (
              <Section id={`${ids}-inbox`} title="Inbox suggestions">
                <Choice
                  type="checkbox"
                  checked={suggest}
                  onChange={setSuggest}
                  label={`Suggest ${trimmed || panel.name} for new items in the Inbox`}
                  hint="Untick for a panel you file into alongside another, like a Next up, so it doesn't attract everything."
                />
              </Section>
            )}

            {text && (
              <Section id={`${ids}-text`} title="Text">
                <Choice
                  type="checkbox"
                  checked={readOnly}
                  onChange={setReadOnly}
                  label="Read-only"
                  hint="The words can be read but not typed into, until you untick this."
                />
                <Choice
                  type="checkbox"
                  checked={rich}
                  onChange={setRich}
                  label="Show formatting"
                  hint="Draw the words as they are meant: headings, bold and lists. Unticked, you see the characters typed."
                />
              </Section>
            )}

            {refusal && (
              <p role="alert" className="text-over-ink">
                {refusal}
              </p>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <Dialog.Close
                disabled={busy}
                className="shrink-0 rounded-md px-3 py-1.5 text-ink-soft hover:bg-accent-tint hover:text-accent-deep disabled:opacity-50"
              >
                Cancel
              </Dialog.Close>
              <button
                type="submit"
                disabled={!canSave}
                className="milled shrink-0 rounded-md bg-accent px-3.5 py-1.5 font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
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

function Heading({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h3 id={id} className="text-[11px] font-semibold uppercase tracking-[0.08em] text-accent-deep">
      {children}
    </h3>
  );
}

/** A group of settings under its heading, set apart from the one above by a rule. */
function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2.5 border-t border-shade/10 pt-4">
      <Heading id={id}>{title}</Heading>
      {children}
    </section>
  );
}

/** A radio or checkbox with its label and, under it, fainter, what choosing it means. */
function Choice({
  type,
  name,
  checked,
  onChange,
  label,
  hint,
}: {
  type: 'radio' | 'checkbox';
  name?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  hint: string;
}) {
  const labelId = useId();
  const hintId = useId();
  return (
    <label className="flex items-start gap-2.5">
      <input
        type={type}
        name={name}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        // Named by the label alone, the hint describing it: wrapped in one
        // label, both would be read as its name.
        aria-labelledby={labelId}
        aria-describedby={hintId}
        className="mt-1"
      />
      <span>
        <span id={labelId} className={type === 'radio' ? 'block font-medium' : 'block'}>
          {label}
        </span>
        <span id={hintId} className="block text-xs text-ink-faint">
          {hint}
        </span>
      </span>
    </label>
  );
}

export default PanelSettingsQuestion;
