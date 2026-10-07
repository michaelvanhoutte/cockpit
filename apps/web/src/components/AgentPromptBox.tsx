import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';

/**
 * What an Agent that asks for a prompt opens before it starts ("Drop an agent
 * on an item to start a Claude Code session on it", issue 571) - "About" the
 * Item it was dropped on, a box for what to ask, and *Send to Claude*.
 *
 * **Nothing starts until Send**: Cancel, Escape and a press outside all start
 * nothing, and a refusal keeps the box open with what was typed still in it -
 * the same promise the Agent's own form makes.
 */
export function AgentPromptBox({
  agentName,
  about,
  sending,
  refusal,
  onCancel,
  onSend,
  returnFocusTo,
}: {
  agentName: string;
  /** The Item's own label. */
  about: string;
  sending: boolean;
  refusal: string | null;
  onCancel: () => void;
  onSend: (prompt: string) => void;
  returnFocusTo?: HTMLElement | null;
}) {
  const [prompt, setPrompt] = useState('');
  const canSend = !sending && prompt.trim().length > 0;

  return (
    <Dialog.Root
      open
      onOpenChange={(stillOpen) => {
        if (!stillOpen && !sending) onCancel();
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
          <Dialog.Title className="truncate text-base font-semibold">About “{about}”</Dialog.Title>
          <p className="mt-1 text-sm text-ink-soft">{agentName}</p>

          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (canSend) onSend(prompt.trim());
            }}
          >
            <textarea
              autoFocus
              disabled={sending}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              aria-label="What to ask Claude"
              rows={4}
              maxLength={4000}
              className="mt-4 w-full resize-y rounded-md border border-shade/10 bg-field px-3 py-2 text-sm text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft/40"
            />

            {refusal && (
              <p role="alert" className="pt-3 text-sm text-over">
                {refusal}
              </p>
            )}

            <div className="flex justify-end gap-2 pt-5">
              <Dialog.Close
                type="button"
                disabled={sending}
                className="shrink-0 rounded-md border border-shade/10 px-3 py-1.5 text-sm text-ink-soft hover:bg-accent-tint hover:text-accent-deep disabled:opacity-50"
              >
                Cancel
              </Dialog.Close>
              <button
                type="submit"
                disabled={!canSend}
                className="milled shrink-0 rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
              >
                Send to Claude
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// Also the default export, for the lazy `import()` ItemRow.tsx loads this behind.
export default AgentPromptBox;
