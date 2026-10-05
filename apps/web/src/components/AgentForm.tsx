import * as Dialog from '@radix-ui/react-dialog';
import { AGENT_COLORS } from '@cockpit/shared';

/**
 * The form an Agent is made or edited on ("Keep your agents in a dock, and
 * choose which each dashboard shows", issue 570) - `+ New agent` and a
 * tile's own `Edit…` open the same form, over the dock rather than replacing
 * it.
 *
 * **Not `RowForm`.** That component is built for a name and one other
 * thing - a colour, a role - and an Agent has four more: the message
 * template, whether starting it asks for a prompt, and whether it sets the
 * Item In progress. Stretching `RowForm` to carry all of that would be a
 * form-shaped hole punched in a component whose whole point is being that
 * shape for everything else that uses it.
 *
 * **Nothing is sent until Save**, the same promise every other form here
 * makes: Escape, Cancel and a press outside all discard, and a refusal keeps
 * the form open with what was typed still in it.
 */
export function AgentForm({
  title,
  name,
  onName,
  color,
  onColor,
  message,
  onMessage,
  asksForPrompt,
  onAsksForPrompt,
  startsInProgress,
  onStartsInProgress,
  refusal,
  saving,
  onCancel,
  onSave,
  returnFocusTo,
}: {
  /** What is being edited, named: "Edit Scope it". */
  title: string;
  name: string;
  onName: (name: string) => void;
  color: string;
  onColor: (color: string) => void;
  message: string;
  onMessage: (message: string) => void;
  asksForPrompt: boolean;
  onAsksForPrompt: (asksForPrompt: boolean) => void;
  startsInProgress: boolean;
  onStartsInProgress: (startsInProgress: boolean) => void;
  refusal?: string | null;
  saving: boolean;
  onCancel: () => void;
  onSave: () => void;
  returnFocusTo?: HTMLElement | null;
}) {
  const canSave = !saving && name.trim().length > 0;

  return (
    <Dialog.Root
      open
      onOpenChange={(stillOpen) => {
        if (!stillOpen && !saving) onCancel();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-floating bg-shade/30" />
        <Dialog.Content
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            if (!returnFocusTo) return;
            event.preventDefault();
            returnFocusTo.focus();
          }}
          className="fixed z-floating left-1/2 top-1/2 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-shade/10 bg-surface p-5 shadow-lg"
        >
          <Dialog.Title className="truncate text-base font-semibold">{title}</Dialog.Title>

          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (canSave) onSave();
            }}
          >
            <label className="mt-4 block text-xs font-semibold uppercase tracking-wide text-ink-faint">
              Name
              <input
                autoFocus
                disabled={saving}
                value={name}
                onChange={(event) => onName(event.target.value)}
                aria-label="Name of the agent"
                maxLength={60}
                className="mt-1 w-full rounded-md border border-shade/10 bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft/40"
              />
            </label>

            <div role="group" aria-label="Colour of the agent" className="mt-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Colour</p>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {AGENT_COLORS.map((swatch) => (
                  <button
                    key={swatch}
                    type="button"
                    onClick={() => onColor(swatch)}
                    disabled={saving}
                    aria-label={`${swatch} for the agent`}
                    aria-pressed={color === swatch}
                    className={`flex size-8 items-center justify-center rounded-md border disabled:opacity-50 ${
                      color === swatch
                        ? 'border-ink ring-2 ring-ink/20'
                        : 'border-shade/10 hover:border-shade/30'
                    }`}
                  >
                    <span className="block size-4 rounded-full" style={{ backgroundColor: swatch }} />
                  </button>
                ))}
              </div>
            </div>

            <label className="mt-4 block text-xs font-semibold uppercase tracking-wide text-ink-faint">
              Message
              <textarea
                disabled={saving}
                value={message}
                onChange={(event) => onMessage(event.target.value)}
                aria-label="The message this agent sends with an item"
                rows={4}
                maxLength={4000}
                className="mt-1 w-full resize-y rounded-md border border-shade/10 bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft/40"
              />
              <span className="mt-1 block text-xs font-normal normal-case tracking-normal text-ink-faint">
                {'{title}'}, {'{description}'}, {'{link}'} and, where it asks for one, {'{prompt}'}.
              </span>
            </label>

            <label className="mt-3 flex items-center gap-2 text-sm normal-case tracking-normal text-ink">
              <input
                type="checkbox"
                disabled={saving}
                checked={asksForPrompt}
                onChange={(event) => onAsksForPrompt(event.target.checked)}
                className="size-4 rounded border-shade/20"
              />
              Ask for a prompt when dropped
            </label>

            <label className="mt-2 flex items-center gap-2 text-sm normal-case tracking-normal text-ink">
              <input
                type="checkbox"
                disabled={saving}
                checked={startsInProgress}
                onChange={(event) => onStartsInProgress(event.target.checked)}
                className="size-4 rounded border-shade/20"
              />
              Set the item In progress when started
            </label>

            {refusal && (
              <p role="alert" className="pt-3 text-sm text-over">
                {refusal}
              </p>
            )}

            <div className="flex justify-end gap-2 pt-5">
              <Dialog.Close
                type="button"
                disabled={saving}
                className="shrink-0 rounded-md border border-shade/10 px-3 py-1.5 text-sm text-ink-soft hover:bg-accent-tint hover:text-accent-deep disabled:opacity-50"
              >
                Cancel
              </Dialog.Close>
              <button
                type="submit"
                disabled={!canSave}
                className="milled shrink-0 rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-white hover:bg-accent-deep disabled:opacity-50"
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
