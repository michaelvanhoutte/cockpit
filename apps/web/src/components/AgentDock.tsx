import { useLayoutEffect, useRef, useState } from 'react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  ACCOUNT_WIDE,
  waitingOnYou,
  agentsShownOnDashboard,
  colorNoAgentIsUsing,
  DEFAULT_AGENT_MESSAGE,
  uuidv7,
} from '@cockpit/shared';
import type { Agent, AgentRun, HiddenAgent } from '@cockpit/shared';
import { CommandRefused } from '../api/client';
import { AGENT_BEING_DRAGGED, landAgent, liftAgent } from '../agentInTheAir';
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

/**
 * The dock: every Agent, reachable from any Dashboard ("Keep your agents in a
 * dock, and choose which each dashboard shows", issue 570). A strip of tiles
 * at the bottom of the screen - `+ New agent`, then every Agent this Dashboard
 * does not hide.
 *
 * **There is no other place Agents are managed.** A tile's own right-click
 * offers `Edit…`, `Hide on this dashboard` and `Delete…`; the dock's own
 * "…" - and a right-click on the dock's own empty part - lists what is
 * hidden here.
 */
export function AgentDock({
  workspaceId,
  dashboardId,
  agents,
  hiddenAgents,
  hasClaudeCodeConnection,
  agentRuns = [],
  claudeCodeFailing = null,
}: {
  /** The chrome it sits in - a Workspace's own header colour, the same paint `<header>` wears (`pages/Layout.tsx`), so the dock reads as part of the shell rather than a plain panel dropped onto the page. */
  /** This Dashboard's own Workspace - what a hide or show is scoped to. */
  workspaceId: string;
  dashboardId: string;
  agents: Agent[];
  hiddenAgents: HiddenAgent[];
  hasClaudeCodeConnection: boolean;
  /** Every open run in this Workspace - what each tile's count is read off (issue 571). */
  agentRuns?: readonly AgentRun[];
  /** Why Claude last refused this Workspace's Claude Code connection, said on the dock until a start works (issue 571). */
  claudeCodeFailing?: string | null;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveRefusal, setSaveRefusal] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const askedFrom = useRef<HTMLElement | null>(null);
  const newAgentButton = useRef<HTMLButtonElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const command = useCommand();
  const send = useSendCommand();

  /**
   * How tall the dock actually is, so the bar that offers to undo the last
   * change (`undo.tsx`) clears it rather than the two overlapping - which the
   * dock's own tiles growing past `undo.tsx`'s fixed clearance once did
   * ("Keep your agents in a dock, and choose which each dashboard shows",
   * issue 570). A `ResizeObserver` rather than a one-time read: the row never
   * wraps, but its height still moves - the agents' snapshot arriving after
   * the first paint, a horizontal scrollbar appearing once the tiles
   * overflow - the same reason `useMeasuredWidth` (`panels/useScreenWidth.ts`)
   * watches rather than reads once, and the same guard for where nothing can
   * be observed: a test runner with no layout engine.
   */
  useLayoutEffect(() => {
    const el = bar.current;
    if (!el) return;
    const root = document.documentElement;
    const publish = () => root.style.setProperty('--dock-h', `${el.offsetHeight}px`);
    publish();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(publish) : null;
    observer?.observe(el);
    return () => {
      observer?.disconnect();
      root.style.removeProperty('--dock-h');
    };
  }, []);

  const hiddenIdsHere = hiddenAgents
    .filter((hidden) => hidden.dashboardId === dashboardId)
    .map((hidden) => hidden.agentId);
  const tiles = agentsShownOnDashboard({
    agents,
    hiddenAgentIds: hiddenIdsHere,
  });
  const hiddenHere = agents.filter((agent) => hiddenIdsHere.includes(agent.id));
  /** How many open runs each Agent has in this Workspace - a tile's count, live with the snapshot it is read off (issue 571). */
  const runningFor = (agentId: string) => agentRuns.filter((run) => run.agentId === agentId).length;
  /** How many of them are waiting on you ("See on the item when Claude is waiting on you", issue 572). */
  const waitingFor = (agentId: string) => waitingOnYou(agentRuns.filter((run) => run.agentId === agentId));
  const waitingInAll = waitingOnYou(agentRuns);

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
      message: DEFAULT_AGENT_MESSAGE,
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

  const deleteRefusal =
    command.error instanceof CommandRefused && command.variables?.name === 'delete_agent'
      ? command.error.message
      : command.error && command.variables?.name === 'delete_agent'
        ? 'That did not reach the server. Try again.'
        : null;

  return (
    <>
      {/* One right-click target for the whole bar, the badge and the "…"
          included, per its own hidden-count tooltip ("Right-click the
          dock..."): `DockEmptyAreaMenu` wraps the bar whole rather than only
          the scrolling tile strip inside it. */}
      <DockEmptyAreaMenu hiddenHere={hiddenHere} onShow={show}>
        <div
          ref={bar}
          role="toolbar"
          aria-label="Agents"
          className="graphite flex shrink-0 items-center gap-3 py-2.5"
          style={{
            paddingInline: 'calc(0.75rem + var(--edge-left)) calc(0.5rem + var(--edge-right))',
          }}
        >
          <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto rounded-xl bg-black/25 px-2 py-1.5 shadow-[inset_0_1px_3px_rgb(0_0_0/0.45)]">
            <span className="shrink-0 text-xs font-semibold uppercase tracking-[0.11em] text-chrome-ink-faint">
              Agents
            </span>
            <button
              ref={newAgentButton}
              type="button"
              onClick={() => startCreating(newAgentButton.current)}
              className="shrink-0 rounded-xl border border-dashed border-white/15 px-3 py-2.5 text-sm text-chrome-ink-faint hover:border-white/30 hover:bg-white/6 hover:text-chrome-ink"
            >
              + New agent
            </button>

            {tiles.map((agent) => (
              <AgentTile
                key={agent.id}
                agent={agent}
                running={runningFor(agent.id)}
                waiting={waitingFor(agent.id)}
                onEdit={startEditing}
                onHide={hide}
                onDelete={startDeleting}
              />
            ))}

            {/* What stands between these tiles and Claude, where something
                does ("Drop an agent on an item to start a Claude Code
                session on it", issue 571): no connection to start through,
                or one Claude last refused - said until a start through it
                works. */}
            {waitingInAll > 0 && (
              <span
                role="status"
                className="shrink-0 rounded-full bg-due-soft px-2 text-xs text-due-ink"
              >
                {waitingInAll} waiting on you
              </span>
            )}
            {!hasClaudeCodeConnection && agents.length > 0 && (
              <span className="shrink-0 text-xs text-chrome-ink-faint">
                Connect Claude Code to this workspace to start an agent.
              </span>
            )}
            {hasClaudeCodeConnection && claudeCodeFailing && (
              <span
                role="status"
                className="shrink-0 rounded-full bg-over-deep px-2.5 py-1 text-xs font-medium text-white"
              >
                Claude Code is failing: {claudeCodeFailing}
              </span>
            )}
          </div>

          {hiddenHere.length > 0 && (
            <span
              className="shrink-0 text-xs text-chrome-ink-faint"
              title='Right-click the dock, or open its "…", to show them again'
            >
              {hiddenHere.length} hidden here
            </span>
          )}
          <DropdownMenu.Root>
            <MenuTrigger label="What is hidden here" onChrome />
            <MenuContent>
              <DockMenuEntries hiddenHere={hiddenHere} onShow={show} asDropdown />
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
        // ("3 items across 2 workspaces will stop having a type"): a run
        // outlives its Agent, keeping its link and naming "a deleted agent"
        // ("Drop an agent on an item to start a Claude Code session on it",
        // issue 571), so deleting one takes nothing from any Item.
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
    </>
  );
}

// Also the default export, for the lazy `import()` Layout.tsx loads this
// behind - kept out of the initial bundle the same way `ManageConnections`
// is, since neither has to be there the moment the app first paints.
export default AgentDock;

/**
 * What makes a tile something to drop on an Item ("Drop an agent on an item
 * to start a Claude Code session on it", issue 571): carried under its own
 * type, and recorded as in the air so every row that will take it can say so
 * before the drop.
 */
function pickedUpAs(agentId: string, name: string) {
  return {
    draggable: true,
    onDragStart: (event: React.DragEvent) => {
      event.dataTransfer.setData(AGENT_BEING_DRAGGED, agentId);
      // Its own type *and* text, for the reason a row's own drag gives:
      // Firefox starts no drag without something it recognises.
      event.dataTransfer.setData('text/plain', name);
      event.dataTransfer.effectAllowed = 'copy';
      liftAgent(agentId);
    },
    onDragEnd: landAgent,
  };
}

/** How many of this Agent's runs are open in this Workspace, where any are. */
function RunCount({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span
      className="rounded-full bg-white/20 px-1.5 text-xs tabular-nums text-chrome-ink"
      title={`${count} open ${count === 1 ? 'run' : 'runs'} in this workspace`}
    >
      {count}
    </span>
  );
}

/** The coloured dot every tile wears. */
function AgentMark({ color }: { color: string }) {
  return (
    <span
      aria-hidden="true"
      className="size-2.5 shrink-0 rounded-full"
      style={{ backgroundColor: color }}
    />
  );
}

/**
 * The chip every tile wears - the same "control on
 * chrome" surface `Menu.tsx`'s `menuButtonClassName` already draws (one
 * `hover`/`data-[state=open]` value, not a border that steps separately from
 * the fill), sized for a name and a mark rather than an icon.
 */
const TILE_CLASS =
  'flex shrink-0 cursor-grab items-center gap-2.5 rounded-xl border border-white/10 bg-white/6 py-2 pr-4 pl-3 hover:bg-white/10 data-[state=open]:bg-white/10';

/** How many of this Agent's runs are waiting on you, where any are (issue 572). */
function WaitingCount({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span
      className="rounded-full bg-due-soft px-1.5 text-xs tabular-nums text-due-ink"
      title={`${count} waiting on you`}
    >
      {count}
      {/* Said, not only hovered: the title is not read out, and a tile's
          name would otherwise run its two counts together. */}
      <span className="sr-only"> waiting on you</span>
    </span>
  );
}

/** One made Agent's tile: its colour mark, its name, its open runs, how many wait on you, and its own menu. */
function AgentTile({
  agent,
  running,
  waiting,
  onEdit,
  onHide,
  onDelete,
}: {
  agent: Agent;
  running: number;
  waiting: number;
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
          {...pickedUpAs(agent.id, agent.name)}
          className={TILE_CLASS}
        >
          <AgentMark color={agent.color} />
          <span className="text-sm font-medium text-chrome-ink">{agent.name}</span>
          <RunCount count={running} />
          <WaitingCount count={waiting} />
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
  onShow,
  asDropdown,
}: {
  hiddenHere: Agent[];
  onShow: (agentId: string) => void;
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
    </>
  );
}

/** The dock's own empty part: a right-click there offers the same entries as its "…" ("The dock is where agents are, and only there", issue 570). */
function DockEmptyAreaMenu({
  hiddenHere,
  onShow,
  children,
}: {
  hiddenHere: Agent[];
  onShow: (agentId: string) => void;
  children: React.ReactNode;
}) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenuContent label="The agents' dock">
        <DockMenuEntries hiddenHere={hiddenHere} onShow={onShow} asDropdown={false} />
      </ContextMenuContent>
    </ContextMenu.Root>
  );
}
