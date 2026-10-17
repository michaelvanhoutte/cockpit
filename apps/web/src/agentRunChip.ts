import { CLAUDE_DESTINATION_NAMES, STARTING_GIVES_UP_AFTER_MS, type AgentRun } from '@cockpit/shared';
import { whereALinkOpens } from './itemSource';

/**
 * What a row's chip says about its run - an Item sent to Claude, or one an
 * Agent started before Agents were retired ("Drop an agent on an item to start
 * a Claude Code session on it", issue 571). Pure, so every wording is provable
 * without drawing a row, with the clock handed in.
 *
 * **A run still starting after two minutes is not believed.** Starting is
 * written before Claude is called and settled straight after, so one still
 * starting that long is a request that died between the two - and Claude may
 * or may not have started a session, which is exactly what `unknown` says.
 */
export interface RunChip {
  /** Who started it: the Agent's name, or "a deleted agent"; empty for an Item sent to Claude, whose chip needs no one named. */
  agent: string;
  text: string;
  /** The session to open, where there is one. */
  href: string | null;
  /** What hovering adds: why Claude refused, or what to do about an unknown. */
  hint: string | null;
  /** Whether this chip reads as a problem. */
  trouble: boolean;
  /** Whether Claude has stopped and is waiting on you (issue 572) - amber, never a problem. */
  waiting: boolean;
}

/** The host a link really opens, which a note cannot rename; empty for an address that does not parse. */
function hostOf(link: string): string {
  try {
    return new URL(link).host;
  } catch {
    return '';
  }
}

/**
 * Where a link the Run holds opens: an `https` address as it is, and the guest
 * demo's own as Cockpit's page for it ("Retire the agents' dock and routines,
 * keeping what each agent knew", issue 1165); anything else is not drawn.
 */
function openable(link: string | null | undefined): string | null {
  return link?.startsWith('https://') ? whereALinkOpens(link) : null;
}

/**
 * The session a run's menu entry opens. A sent Run's chip may open what Claude
 * made instead once it is ready, so the session is read from the Run itself.
 */
export function sessionHrefFor(run: AgentRun, chip: RunChip): string | null {
  return run.destination ? openable(run.sessionUrl) : chip.href;
}

export function runChipFor(run: AgentRun, now: number): RunChip {
  // An Item sent to Cowork or Claude Code from its row ("Send an item to Cowork
  // or Claude Code with its prompt reviewed first", issue 1159): it was
  // opened in Claude's desktop app, and nothing yet says more than that.
  if (run.destination) {
    const name = CLAUDE_DESTINATION_NAMES[run.destination];
    // What Claude has reported since ("Follow on the row what Claude reports
    // back", issue 1160). A link is drawn only if it is an `https` address,
    // however it came to be stored.
    const session = openable(run.sessionUrl);
    const base = { agent: '', trouble: false, waiting: false };
    switch (run.stage) {
      case 'on_it':
        return { ...base, text: `${name} is on it${session ? ' ↗' : ''}`, href: session, hint: session ? 'Open the session' : null };
      case 'ready':
        const opens = openable(run.resultUrl) ?? session;
        return {
          ...base,
          text: `Ready${opens ? ' ↗' : ''}`,
          href: opens,
          hint: opens && hostOf(opens) ? `Opens ${hostOf(opens)}${run.note ? ` - ${run.note}` : ''}` : (run.note ?? null),
        };
      case 'needs_you':
        return {
          ...base,
          text: `Needs you${session ? ' ↗' : ''}`,
          href: session,
          hint: run.note ?? null,
          waiting: true,
        };
    }
    return { ...base, text: `Sent to ${name}`, href: null, hint: 'Opened in Claude. Press send there.' };
  }
  const agent = run.agentName ?? 'a deleted agent';
  // A simulated run's session is a demo address, which opens Cockpit's own page
  // for it ("Show agents at work in the guest demo, with simulated runs", issue 774).
  const href = run.sessionUrl === null ? null : whereALinkOpens(run.sessionUrl);
  const status =
    run.status === 'starting' && now - Date.parse(run.startedAt) > STARTING_GIVES_UP_AFTER_MS
      ? 'unknown'
      : run.status;
  switch (status) {
    case 'starting':
      return { agent, text: 'Starting Claude…', href: null, hint: null, trouble: false, waiting: false };
    case 'working':
      // What the session's hooks last said, where the repository has them
      // ("See on the item when Claude is waiting on you", issue 572).
      return run.waiting
        ? { agent, text: 'Claude is waiting on you ↗', href, hint: 'Open the Claude session to answer', trouble: false, waiting: true }
        : { agent, text: 'Claude is working ↗', href, hint: 'Open the Claude session', trouble: false, waiting: false };
    case 'link_lost':
      return {
        agent,
        text: 'Claude started - its link was lost',
        href: null,
        hint: 'The session is in your Claude Code sessions list',
        trouble: true,
        waiting: false,
      };
    case 'unknown':
      return {
        agent,
        text: 'Unknown - check Claude',
        href: null,
        hint: "Claude's answer never arrived, so a session may have started",
        trouble: true,
        waiting: false,
      };
    case 'failed':
      return { agent, text: "Claude didn't start", href: null, hint: run.reason, trouble: true, waiting: false };
  }
}
