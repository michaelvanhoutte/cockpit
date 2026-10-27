/**
 * One pull request's timeline as the piece an opened Pull request row on Cycle time shows under its outline:
 * its strip and one line of colour key, or "Timeline not recorded." where the Monitor holds none that fits its
 * rounds. Read when the row is opened, one request for the one pull request (`GET /cycle-time/timeline`), never
 * carried in the page, since a timeline runs to tens of KB.
 */

import { timelineMisfit, type CycleTimeline } from './cycle-time';
import { storedPull, type CycleTimePull } from './cycle-time-store';
import { stripOf } from './pull-request-strip';
import { renderTimeline } from './pull-request-timeline';

/** A pull request the Monitor holds, with the timeline its strip is drawn from; `timeline` is null where none is stored or it does not fit the rounds stored. */
export interface FoundTimeline {
  pull: CycleTimePull;
  timeline: CycleTimeline | null;
}

/** The stored timeline, parsed, where it fits the rounds stored for the pull request; a timeline that does not is as good as none, never drawn. */
function fitting(pull: CycleTimePull, stored: string | undefined): CycleTimeline | null {
  if (stored === undefined) return null;
  try {
    const timeline = JSON.parse(stored) as CycleTimeline;
    return timelineMisfit(timeline, pull.rounds.length, 'it has') === null ? timeline : null;
  } catch {
    return null;
  }
}

/** One pull request's row, rounds, checks and timeline, in one batch; null for a number the Monitor does not hold. */
export async function loadTimeline(db: D1Database, number: number): Promise<FoundTimeline | null> {
  const [stored, rounds, checks, timelines] = await db.batch([
    db.prepare('SELECT * FROM cycle_time_pulls WHERE pull_number = ?').bind(number),
    db.prepare('SELECT * FROM cycle_time_rounds WHERE pull_number = ? ORDER BY round_index').bind(number),
    db.prepare('SELECT * FROM cycle_time_checks WHERE pull_number = ? ORDER BY round_index, position').bind(number),
    db.prepare('SELECT timeline FROM cycle_time_timelines WHERE pull_number = ?').bind(number),
  ]);
  const pull = storedPull({ pull: stored!.results, rounds: rounds!.results, checks: checks!.results });
  if (pull === null) return null;
  return { pull, timeline: fitting(pull, (timelines!.results[0] as { timeline: string } | undefined)?.timeline) };
}

/**
 * The piece as HTML: the strip with its key, preceded by the rules that name this strip's own ids. Where nothing fits
 * the rounds it reads "Timeline not recorded.", never an empty or misdrawn strip.
 */
export function renderTimelinePiece({ pull, timeline }: FoundTimeline): string {
  if (timeline === null) return '<p class="tl-none">Timeline not recorded.</p>';
  const drawn = renderTimeline(stripOf(pull, timeline), { name: pull.base, trunk: pull.base === 'main', landing: pull.landing, head: pull.head });
  return `<style>${drawn.style}</style>${drawn.html}`;
}
