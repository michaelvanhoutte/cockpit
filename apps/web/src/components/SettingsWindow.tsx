import { lazy, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useWorkspaces } from '../api/useWorkspaces';
import type { ConnectOutcome, RefusedBecause } from '../connections';
import { SettingsModal } from './SettingsModal';

// One chunk each, fetched when its section is first shown: only the modal is
// fetched on opening, and a section still arriving never takes it down.
const ManageConnections = lazy(() => import('./ManageConnections'));
const ManageConnectedApps = lazy(() => import('./ManageConnectedApps'));
const ManageAppearance = lazy(() => import('./ManageAppearance'));
const ManageRememberedSentences = lazy(() => import('./ManageRememberedSentences'));

/** The sections of Settings, in the order they are listed. */
export type SettingsKey = 'connections' | 'mcp' | 'remembered' | 'appearance';

/** How a trip out to Microsoft or Google ended, and the workspace it was made from. */
export interface ConnectOutcomeFor {
  workspaceId: string;
  outcome: ConnectOutcome;
  /** Which connector refused the grant and why, where its own account step did. */
  because?: RefusedBecause;
}

/**
 * Settings: the account's Gmail and Teams connections, the MCP apps and the
 * sentences Cockpit remembers, each the content of the window it used to have
 * ("Open Settings from the profile menu, with connections, agent settings and
 * MCP as its sections", issue 693). *Agent settings* went with the routines
 * ("Retire the agents' dock and routines, keeping what each agent knew", issue
 * 1165), leaving MCP as the only setup Claude needs.
 */
export default function SettingsWindow({
  on,
  startsIn,
  outcome,
  guest,
  sentenceId,
  onlyAppearance,
  onClose,
  returnFocusTo,
}: {
  /** The section it opens on. */
  on: SettingsKey;
  /** The open workspace, which the picker of Connections starts on. */
  startsIn: string | undefined;
  /** How the last connect attempt went, where Settings has been reopened by one. */
  outcome?: ConnectOutcomeFor | undefined;
  /** The shared guest, who is offered no connection to make (issue 772). */
  guest?: boolean | undefined;
  /** The remembered sentence *What Cockpit remembers* opens for editing, where a window that used it sent the person here. */
  sentenceId?: string | undefined;
  /** On a phone, which holds Appearance and nothing else: the rest of Settings is for a desk. */
  onlyAppearance?: boolean | undefined;
  onClose: () => void;
  returnFocusTo?: HTMLElement | null | undefined;
}) {
  const appearance = { key: 'appearance', label: 'Appearance', content: <ManageAppearance /> };
  return (
    <SettingsModal
      title="Settings"
      initial={on}
      onClose={onClose}
      returnFocusTo={returnFocusTo}
      sections={onlyAppearance ? [appearance] : [
        appearance,
        {
          key: 'connections',
          label: 'Connections',
          content: <ConnectionsOf startsIn={startsIn} outcome={outcome} guest={guest} onClose={onClose} />,
        },
        { key: 'mcp', label: 'MCP', content: <ManageConnectedApps open onClose={onClose} /> },
        { key: 'remembered', label: 'What Cockpit remembers', content: <ManageRememberedSentences focus={sentenceId} /> },
      ]}
    />
  );
}

/**
 * The connections, for one workspace at a time: a connection belongs to the
 * workspace that made it, so the section asks which,
 * starting on the one that is open. The picker is there even for an account with one workspace, so
 * it always says whose connections these are.
 */
function ConnectionsOf({
  startsIn,
  outcome,
  guest,
  onClose,
}: {
  guest?: boolean | undefined;
  startsIn: string | undefined;
  outcome?: ConnectOutcomeFor | undefined;
  onClose: () => void;
}) {
  const { data } = useWorkspaces();
  const workspaces = data?.workspaces ?? [];
  const [picked, setPicked] = useState(outcome?.workspaceId ?? startsIn);
  const chosen = workspaces.find((ws) => ws.id === picked) ?? workspaces[0];
  if (!chosen) return null;
  return (
    <ManageConnections
      // Remounted per workspace, so one's half-answered question is not still
      // open over the next.
      key={chosen.id}
      guest={guest}
      workspaceId={chosen.id}
      workspaceName={chosen.name}
      outcome={outcome?.workspaceId === chosen.id ? outcome.outcome : undefined}
      because={outcome?.workspaceId === chosen.id ? outcome.because : undefined}
      open
      onClose={onClose}
      picker={
        <select
          aria-label="Workspace"
          value={chosen.id}
          onChange={(event) => setPicked(event.target.value)}
          className="rounded-md border border-shade/20 bg-field px-2 py-0.5 text-sm font-semibold text-ink-strong"
        >
          {workspaces.map((ws) => (
            <option key={ws.id} value={ws.id}>
              {ws.name}
            </option>
          ))}
        </select>
      }
    />
  );
}
