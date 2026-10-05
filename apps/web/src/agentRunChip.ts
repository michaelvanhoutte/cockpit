import { STARTING_GIVES_UP_AFTER_MS, type AgentRun } from '@cockpit/shared';
import { whereALinkOpens } from './itemSource';

/**
 * What a row's chip says about its run ("Drop an agent on an item to start a
 * Claude Code session on it", issue 571). Pure, so every wording is provable
 * without drawing a row, with the clock handed in.
 *
 * **A run still starting after two minutes is not believed.** Starting is
 * written before Claude is called and settled straight after, so one still
 * starting that long is a request that died between the two - and Claude may
 * or may not have started a session, which is exactly what `unknown` says.
 */
export interface RunChip {
  /** Who started it: the Agent's name, or "a deleted agent". */
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

export function runChipFor(run: AgentRun, now: number): RunChip {
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
