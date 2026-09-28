import { useRef, useState } from 'react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  ACCOUNT_WIDE,
  ASK_CLAUDE_COLOR,
  ASK_CLAUDE_ID,
  ASK_CLAUDE_NAME,
  agentsShownOnDashboard,
  colorNoAgentIsUsing,
  uuidv7,
} from '@cockpit/shared';
import type { Agent, HiddenAgent } from '@cockpit/shared';
import { CommandRefused } from '../api/client';
import { useCommand, useSendCommand } from '../api/queries';
import { AgentForm } from './AgentForm';
import { ContextMenuContent, destructiveItemClass, menuItemClass, MenuContent, MenuTrigger } from './Menu';
import { DeleteQuestion } from './DeleteQuestion';

/** A draft the create/edit form holds - nothing here has been sent, Save is what sends it. */
interface Draft {
  id: string | null;
  name: string;
  color: string;
  message: string;
  asksForPrompt: boolean;
  startsInProgress: boolean;
}

const BLANK_MESSAGE = '{title}\n\n{description}';

/**
 * The dock: every Agent, reachable from any Dashboard ("Keep your agents in a
 * dock, and choose which each dashboard shows", issue 570). A strip of tiles
 * at the bottom of the screen - `+ New agent`, then Ask Claude where it is
 * drawn at all, then every made Agent this Dashboard does not hide.
 *
 * **There is no other place Agents are managed.** A tile's own right-click
 * offers `Edit…`, `Hide on this dashboard` and `Delete…`; the dock's own
 * "…" - and a right-click on the dock's own empty part - lists what is
 * hidden here and carries the Ask Claude switch.
 */
export function AgentDock({
  workspaceId,
  dashboardId,
  agents,
  hiddenAgents,
  hasClaudeCodeConnection,
  askClaudeEnabled,
}: {
  /** This Dashboard's own Workspace - what a hide or show is scoped to. */
  workspaceId: string;
  dashboardId: string;
  agents: Agent[];
  hiddenAgents: HiddenAgent[];
  hasClaudeCodeConnection: boolean;
  askClaudeEnabled: boolean;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveRefusal, setSaveRefusal] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const askedFrom = useRef<HTMLElement | null>(null);
  const newAgentButton = useRef<HTMLButtonElement>(null);
  const command = useCommand();
  const send = useSendCommand();

  const hiddenIdsHere = hiddenAgents
    .filter((hidden) => hidden.dashboardId === dashboardId)
    .map((hidden) => hidden.agentId);
  const tiles = agentsShownOnDashboard({
    agents,
    hiddenAgentIds: hiddenIdsHere,
    askClaudeEnabled,
    hasClaudeCodeConnection,
  });
  const hiddenHere = agents.filter((agent) => hiddenIdsHere.includes(agent.id));

  const accountEnvelope = () => ({
    commandId: uuidv7(),
    issuedAt: new Date().toISOString(),
    workspaceId: ACCOUNT_WIDE,
  });
  const dashboardEnvelope = () => ({
    commandId: uuidv7(),
    issuedAt: new Date().toISOString(),
    workspaceId,
  });

  const beingEdited = draft?.id ? agents.find((agent) => agent.id === draft.id) : undefined;
  const beingDeleted = agents.find((agent) => agent.id === deleting);

  const startCreating = (openedFrom: HTMLElement | null) => {
    setDeleting(null);
    command.reset();
    setSaveRefusal(null);
    askedFrom.current = openedFrom;
    setDraft({
      id: null,
      name: '',
      color: colorNoAgentIsUsing(agents.map((agent) => agent.color)),
      message: BLANK_MESSAGE,
      asksForPrompt: false,
      startsInProgress: true,
    });
  };
  const startEditing = (agent: Agent, openedFrom: HTMLElement | null) => {
    setDeleting(null);
    command.reset();
    setSaveRefusal(null);
    askedFrom.current = openedFrom;
    setDraft({
      id: agent.id,
      name: agent.name,
      color: agent.color,
      message: agent.message,
      asksForPrompt: agent.asksForPrompt,
      startsInProgress: agent.startsInProgress,
    });
  };
  const startDeleting = (agent: Agent, openedFrom: HTMLElement | null) => {
    setDraft(null);
    command.reset();
    askedFrom.current = openedFrom;
    setDeleting(agent.id);
  };
  const closeForm = () => {
    setDraft(null);
    setSaveRefusal(null);
  };
  const stopAsking = () => {
    setDeleting(null);
    command.reset();
  };

  const saveForm = async () => {
    if (!draft) return;
    const name = draft.name.trim();
    if (!name) return;

    setSaving(true);
    setSaveRefusal(null);
    try {
      if (draft.id) {
        await send({
          name: 'update_agent',
          payload: {
            ...accountEnvelope(),
            agentId: draft.id,
            name,
            color: draft.color,
            message: draft.message,
            asksForPrompt: draft.asksForPrompt,
            startsInProgress: draft.startsInProgress,
          },
        });
      } else {
        await send({
          name: 'create_agent',
          payload: {
            ...accountEnvelope(),
            agentId: uuidv7(),
            name,
            color: draft.color,
            engine: 'claude-code',
            message: draft.message,
            asksForPrompt: draft.asksForPrompt,
            startsInProgress: draft.startsInProgress,
          },
        });
      }
      closeForm();
    } catch (failure) {
      setSaveRefusal(
        failure instanceof CommandRefused
          ? failure.message
          : 'That did not reach the server. Try again.',
      );
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = (agentId: string) => {
    command.mutate(
      { name: 'delete_agent', payload: { ...accountEnvelope(), agentId } },
      { onSuccess: () => setDeleting(null) },
    );
  };

  const hide = (agentId: string) => {
    command.mutate({
      name: 'hide_agent_on_dashboard',
      payload: { ...dashboardEnvelope(), agentId, dashboardId },
    });
  };
  const show = (agentId: string) => {
    command.mutate({
      name: 'show_agent_on_dashboard',
      payload: { ...dashboardEnvelope(), agentId, dashboardId },
    });
  };
  const toggleAskClaude = () => {
    command.mutate({
      name: 'set_ask_claude_enabled',
      payload: { ...accountEnvelope(), enabled: !askClaudeEnabled },
    });
  };

  const deleteRefusal =
    command.error instanceof CommandRefused && command.variables?.name === 'delete_agent'
      ? command.error.message
      : command.error && command.variables?.name === 'delete_agent'
        ? 'That did not reach the server. Try again.'
        : null;

  return (
    <div
      role="toolbar"
      aria-label="Agents"
      className="flex shrink-0 items-center gap-2 border-t border-black/10 bg-surface px-3 py-2"
    >
      <DockEmptyAreaMenu
        hiddenHere={hiddenHere}
        askClaudeEnabled={askClaudeEnabled}
        onShow={show}
        onToggleAskClaude={toggleAskClaude}
      >
        <div className="flex flex-1 items-center gap-2 overflow-x-auto">
          <button
            ref={newAgentButton}
            type="button"
            onClick={() => startCreating(newAgentButton.current)}
            className="shrink-0 rounded-md border border-dashed border-black/20 px-3 py-1.5 text-sm text-ink-soft hover:border-accent hover:text-accent-deep"
          >
            + New agent
          </button>

          {tiles.map((tile) =>
            tile.kind === 'ask-claude' ? (
              <div
                key={ASK_CLAUDE_ID}
                className="flex shrink-0 items-center gap-1.5 rounded-md border border-black/10 px-3 py-1.5 text-sm"
              >
                <span
                  aria-hidden="true"
                  className="inline-block size-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: ASK_CLAUDE_COLOR }}
                />
                {ASK_CLAUDE_NAME}
              </div>
            ) : (
              <AgentTile
                key={tile.agent.id}
                agent={tile.agent}
                onEdit={startEditing}
                onHide={hide}
                onDelete={startDeleting}
              />
            ),
          )}

          <DropdownMenu.Root>
            <MenuTrigger label="What is hidden here, and the Ask Claude switch" className="ml-auto" />
            <MenuContent>
              <DockMenuEntries
                hiddenHere={hiddenHere}
                askClaudeEnabled={askClaudeEnabled}
                onShow={show}
                onToggleAskClaude={toggleAskClaude}
                asDropdown
              />
            </MenuContent>
          </DropdownMenu.Root>
        </div>
      </DockEmptyAreaMenu>

      {draft && (
        <AgentForm
          title={beingEdited ? `Edit ${beingEdited.name}` : 'New agent'}
          name={draft.name}
          onName={(name) => setDraft({ ...draft, name })}
          color={draft.color}
          onColor={(color) => setDraft({ ...draft, color })}
          message={draft.message}
          onMessage={(message) => setDraft({ ...draft, message })}
          asksForPrompt={draft.asksForPrompt}
          onAsksForPrompt={(asksForPrompt) => setDraft({ ...draft, asksForPrompt })}
          startsInProgress={draft.startsInProgress}
          onStartsInProgress={(startsInProgress) => setDraft({ ...draft, startsInProgress })}
          refusal={saveRefusal}
          saving={saving}
          returnFocusTo={askedFrom.current}
          onCancel={closeForm}
          onSave={() => void saveForm()}
        />
      )}
      {beingDeleted && (
        // Names no usage the way ManageTypes' own delete question does
        // ("3 items across 2 workspaces will stop having a type"), because
        // nothing yet links an Agent to an Item to count: "Drop an agent on
        // an item to start a Claude Code session on it" is its own issue,
        // out of scope here (issue 570, "Out of scope / open questions").
        // Retrofit this question once that lands.
        <DeleteQuestion
          open
          question={`Delete ${beingDeleted.name}?`}
          confirmLabel={`Yes, delete ${beingDeleted.name}`}
          canConfirm={!command.isPending}
          refusal={deleteRefusal}
          returnFocusTo={askedFrom.current}
          onCancel={stopAsking}
          onConfirm={() => confirmDelete(beingDeleted.id)}
        />
      )}
    </div>
  );
}

// Also the default export, for the lazy `import()` Layout.tsx loads this
// behind - kept out of the initial bundle the same way `ManageConnections`
// is, since neither has to be there the moment the app first paints.
export default AgentDock;

/** One made Agent's tile: a colour dot, its name, and its own menu. */
function AgentTile({
  agent,
  onEdit,
  onHide,
  onDelete,
}: {
  agent: Agent;
  onEdit: (agent: Agent, openedFrom: HTMLElement | null) => void;
  onHide: (agentId: string) => void;
  onDelete: (agent: Agent, openedFrom: HTMLElement | null) => void;
}) {
  const tile = useRef<HTMLButtonElement>(null);
  const chose = useRef(false);

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <button
          ref={tile}
          type="button"
          onClick={() => onEdit(agent, tile.current)}
          className="flex shrink-0 items-center gap-1.5 rounded-md border border-black/10 px-3 py-1.5 text-sm hover:border-accent"
        >
          <span
            aria-hidden="true"
            className="inline-block size-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: agent.color }}
          />
          {agent.name}
        </button>
      </ContextMenu.Trigger>
      <ContextMenuContent
        label={`Actions for ${agent.name}`}
        onCloseAutoFocus={(event) => {
          const claimed = chose.current;
          chose.current = false;
          if (!claimed) return;
          event.preventDefault();
        }}
      >
        <ContextMenu.Item
          className={menuItemClass}
          onSelect={() => {
            chose.current = true;
            onEdit(agent, tile.current);
          }}
        >
          Edit…
        </ContextMenu.Item>
        <ContextMenu.Item
          className={menuItemClass}
          onSelect={() => {
            chose.current = false;
            onHide(agent.id);
          }}
        >
          Hide on this dashboard
        </ContextMenu.Item>
        <ContextMenu.Item
          className={destructiveItemClass}
          onSelect={() => {
            chose.current = true;
            onDelete(agent, tile.current);
          }}
        >
          Delete…
        </ContextMenu.Item>
      </ContextMenuContent>
    </ContextMenu.Root>
  );
}

/** What the dock's own "…" and a right-click on its empty part both offer - one list, shared by both triggers. */
function DockMenuEntries({
  hiddenHere,
  askClaudeEnabled,
  onShow,
  onToggleAskClaude,
  asDropdown,
}: {
  hiddenHere: Agent[];
  askClaudeEnabled: boolean;
  onShow: (agentId: string) => void;
  onToggleAskClaude: () => void;
  /** Which Radix item primitive to draw with - `DropdownMenu.Item` or `ContextMenu.Item`. */
  asDropdown: boolean;
}) {
  const Item = asDropdown ? DropdownMenu.Item : ContextMenu.Item;
  const Label = asDropdown ? DropdownMenu.Label : ContextMenu.Label;

  return (
    <>
      <Label className="px-2 py-1 text-xs text-ink-faint">
        {hiddenHere.length === 0 ? 'Nothing hidden here' : `${hiddenHere.length} hidden here`}
      </Label>
      {hiddenHere.map((agent) => (
        <Item key={agent.id} className={menuItemClass} onSelect={() => onShow(agent.id)}>
          Show {agent.name}
        </Item>
      ))}
      <Item className={menuItemClass} onSelect={onToggleAskClaude}>
        {askClaudeEnabled ? 'Turn off Ask Claude everywhere' : 'Turn on Ask Claude everywhere'}
      </Item>
    </>
  );
}

/** The dock's own empty part: a right-click there offers the same entries as its "…" ("The dock is where agents are, and only there", issue 570). */
function DockEmptyAreaMenu({
  hiddenHere,
  askClaudeEnabled,
  onShow,
  onToggleAskClaude,
  children,
}: {
  hiddenHere: Agent[];
  askClaudeEnabled: boolean;
  onShow: (agentId: string) => void;
  onToggleAskClaude: () => void;
  children: React.ReactNode;
}) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenuContent label="The agents' dock">
        <DockMenuEntries
          hiddenHere={hiddenHere}
          askClaudeEnabled={askClaudeEnabled}
          onShow={onShow}
          onToggleAskClaude={onToggleAskClaude}
          asDropdown={false}
        />
      </ContextMenuContent>
    </ContextMenu.Root>
  );
}
