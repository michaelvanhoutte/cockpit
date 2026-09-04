import { useState } from 'react';
import { uuidv7 } from '@cockpit/shared';
import { useCommand } from '../api/queries';

/**
 * Fast capture (§5.4): today this posts capture_item directly; the
 * create-only outbox (local write first, flush when connectivity allows)
 * wraps this same command when the PWA capture work lands.
 */
export function CaptureForm({ workspaceId }: { workspaceId: string }) {
  const [message, setMessage] = useState('');
  const command = useCommand();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = message.trim();
    if (!trimmed) return;
    command.mutate({
      name: 'capture_item',
      payload: {
        commandId: uuidv7(),
        issuedAt: new Date().toISOString(),
        workspaceId,
        itemId: uuidv7(),
        message: trimmed,
      },
    });
    setMessage('');
  };

  return (
    <form onSubmit={submit} className="flex gap-2">
      {/* `min-w-0` is what lets the box be narrower than the twenty characters
          an input asks for by default. Without it the box refuses to shrink
          and pushes the button out of the panel instead - which is invisible
          to the page-level sideways-scroll check, because the Inbox column
          scrolls inside itself. Found in the browser at 280px, the narrowest
          the column ever gets ("Show the Inbox beside the dashboards instead
          of as a tab", issue 117). */}
      <input
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="Capture a note or to-do…"
        aria-label="Capture a note or to-do"
        className="min-w-0 flex-1 rounded-md border border-black/10 bg-white px-3 py-2 text-sm shadow-[inset_0_1px_2px_rgb(41_43_49/0.06)] outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft/40"
      />
      <button
        type="submit"
        disabled={command.isPending}
        className="milled shrink-0 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-deep disabled:opacity-50"
      >
        Capture
      </button>
    </form>
  );
}
