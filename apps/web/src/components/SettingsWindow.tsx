import { lazy, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CLAUDE_CODE, GMAIL, TEAMS } from '@cockpit/shared';
import { workspacesQuery } from '../api/queries';
import type { ConnectOutcome } from '../connections';
import { SettingsModal } from './SettingsModal';

// One chunk each, fetched when its section is first shown: only the modal is
// fetched on opening, and a section still arriving never takes it down.
const ManageTypes = lazy(() => import('./ManageTypes'));
const ManageConnections = lazy(() => import('./ManageConnections'));
const ManageConnectedApps = lazy(() => import('./ManageConnectedApps'));

/** The sections of Settings, in the order they are listed. */
export type SettingsKey = 'types' | 'connections' | 'agents' | 'mcp';

/** How a trip out to Microsoft or Google ended, and the workspace it was made from. */
export interface ConnectOutcomeFor {
  workspaceId: string;
  outcome: ConnectOutcome;
}

/** The sources Connections offers, beside the Claude Code connection Agent settings holds. */
const SOURCES = [GMAIL, TEAMS] as const;
const AGENTS = [CLAUDE_CODE] as const;

/**
 * Settings: the account's types, its Gmail and Teams connections, the Claude Code
 * connection and the MCP apps, each the content of the window it used to have
 * ("Open Settings from the profile menu, with types, connections, agent
 * settings and MCP as its sections", issue 693).
 */
export default function SettingsWindow({
  on,
  startsIn,
  outcome,
  onClose,
  returnFocusTo,
}: {
  /** The section it opens on. */
  on: SettingsKey;
  /** The open workspace, which the pickers of Connections and Agent settings start on. */
  startsIn: string | undefined;
  /** How the last connect attempt went, where Settings has been reopened by one. */
  outcome?: ConnectOutcomeFor | undefined;
  onClose: () => void;
  returnFocusTo?: HTMLElement | null | undefined;
}) {
  return (
    <SettingsModal
      title="Settings"
      initial={on}
      onClose={onClose}
      returnFocusTo={returnFocusTo}
      sections={[
        { key: 'types', label: 'Types', content: <ManageTypes open onClose={onClose} /> },
        {
          key: 'connections',
          label: 'Connections',
          content: <ConnectionsOf connectors={SOURCES} startsIn={startsIn} outcome={outcome} onClose={onClose} />,
        },
        {
          key: 'agents',
          label: 'Agent settings',
          content: <ConnectionsOf connectors={AGENTS} startsIn={startsIn} onClose={onClose} />,
        },
        { key: 'mcp', label: 'MCP', content: <ManageConnectedApps open onClose={onClose} /> },
      ]}
    />
  );
}

/**
 * The kinds of connection one section holds, for one workspace at a time: a
 * connection belongs to the workspace that made it, so the section asks which,
 * starting on the one that is open. The picker is there even for an account with one workspace, so
 * it always says whose connections these are.
 */
function ConnectionsOf({
  connectors,
  startsIn,
  outcome,
  onClose,
}: {
  connectors: readonly string[];
  startsIn: string | undefined;
  outcome?: ConnectOutcomeFor | undefined;
  onClose: () => void;
}) {
  const { data } = useQuery(workspacesQuery);
  const workspaces = data?.workspaces ?? [];
  const [picked, setPicked] = useState(outcome?.workspaceId ?? startsIn);
  const chosen = workspaces.find((ws) => ws.id === picked) ?? workspaces[0];
  if (!chosen) return null;
  return (
    <ManageConnections
      // Remounted per workspace, so one's half-answered question is not still
      // open over the next.
      key={chosen.id}
      only={connectors}
      workspaceId={chosen.id}
      workspaceName={chosen.name}
      outcome={outcome?.workspaceId === chosen.id ? outcome.outcome : undefined}
      open
      onClose={onClose}
      picker={
        <label className="mt-3 block text-sm text-ink-soft">
          Workspace{' '}
          <select
            value={chosen.id}
            onChange={(event) => setPicked(event.target.value)}
            className="rounded border border-black/10 px-1 py-0.5"
          >
            {workspaces.map((ws) => (
              <option key={ws.id} value={ws.id}>
                {ws.name}
              </option>
            ))}
          </select>
        </label>
      }
    />
  );
}
