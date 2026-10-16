import { useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import type { Workspace } from '@cockpit/shared';
import { snapshotQuery } from '../api/queries';
import { matchingPanels, panelsToFileOn, type FileOnOption } from '../fileOn';

/**
 * The type-ahead behind Capture's *File on* ("File a note on Panels from
 * Capture, skipping the Inbox", issue 1101). **Loaded on first focus**
 * (`FileOnLine.tsx`), so the initial bundle carries only the line and its chips.
 *
 * Reads the snapshot of each Workspace in scope the way Go to panel does: the
 * chosen one, or every one under *Any workspace*, and offline only those already
 * held are searchable - which it says.
 */
export default function FileOnSearch({
  where,
  workspaces,
  chosen,
  onPick,
}: {
  where: string | null;
  workspaces: readonly Workspace[];
  chosen: readonly string[];
  onPick: (option: FileOnOption) => void;
}) {
  const [typed, setTyped] = useState('');
  const reads = useQueries({
    queries: workspaces.map((workspace) => ({
      ...snapshotQuery(workspace.id),
      enabled: where === null || workspace.id === where,
    })),
  });
  const held = workspaces.map((workspace, at) => ({ workspace, snapshot: reads[at]?.data }));
  const { options, leftOut } = panelsToFileOn(held, where);
  const matches = matchingPanels(options, typed, chosen);
  const reading = reads.some((read, at) => read.isPending && read.fetchStatus !== 'idle' && !held[at]?.snapshot);

  const pick = (option: FileOnOption) => {
    onPick(option);
    setTyped('');
  };

  return (
    <div className="relative w-full min-w-0 sm:w-72">
      <input
        type="search"
        autoFocus
        value={typed}
        onChange={(event) => setTyped(event.target.value)}
        onKeyDown={(event) => {
          // Never the form's: Enter here adds a Panel, it does not capture.
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            // Nothing typed is not a choice: the first of the list is no match.
            const top = typed.trim() === '' ? undefined : matches[0];
            if (top) pick(top);
          } else if (event.key === 'Escape' && typed !== '') {
            event.stopPropagation();
            setTyped('');
          }
        }}
        placeholder="Find a Panel…"
        aria-label="Find a Panel to file on"
        autoComplete="off"
        className="min-h-9 w-full rounded-md border border-shade/10 bg-field px-3 text-sm placeholder:text-ink-faint focus:border-accent focus:outline-none sm:min-h-0 sm:py-1 sm:text-[13px]"
      />
      <ul
        aria-label="Panels to file on"
        className="mt-1 max-h-56 overflow-y-auto rounded-md border border-shade/10 bg-surface text-sm shadow-field empty:hidden"
      >
        {matches.slice(0, 50).map((option) => (
          <li key={option.panelId}>
            <button
              type="button"
              onClick={() => pick(option)}
              className="flex w-full items-baseline gap-2 px-3 py-1.5 text-left hover:bg-accent-tint hover:text-accent-deep focus-visible:bg-accent-tint focus-visible:outline-none"
            >
              <span className="min-w-0 flex-1 truncate">{option.name}</span>
              <span className="shrink-0 text-xs text-ink-faint">
                {where === null ? `${option.workspaceName} ▸ ${option.dashboardName}` : option.dashboardName}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {matches.length === 0 && typed.trim() !== '' && !reading && (
        <p className="pt-1 text-xs text-ink-faint">Nothing called “{typed.trim()}”.</p>
      )}
      {leftOut.length > 0 && !reading && (
        <p role="status" className="pt-1 text-xs text-ink-faint">
          Not read yet, so left out: {leftOut.join(', ')}.
        </p>
      )}
    </div>
  );
}
