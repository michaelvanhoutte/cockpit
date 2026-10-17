import { WORKSPACE_THEMES } from './workspace-themes.js';

/**
 * What is left of an Agent: the rows an account already holds ("Retire the
 * agents' dock and routines, keeping what each agent knew", issue 1165). The
 * dock, starting one and every way of making or changing one are gone; each
 * Agent became a remembered sentence, and its row is kept because the Runs it
 * started still name it.
 */

/** The colours an Agent could wear — the palette's tints, which the stored table's CHECK still holds a row to. */
export const AGENT_COLORS: readonly string[] = WORKSPACE_THEMES.map((theme) => theme.tint);

/** What an Agent ran on, which the stored table's CHECK still holds a row to. */
export const AGENT_ENGINES = ['claude-code'] as const;
export type AgentEngine = (typeof AGENT_ENGINES)[number];
