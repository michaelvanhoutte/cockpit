import {
  CLAUDE_REPORTED_STAGES,
  REPORT_LINK_LIMIT,
  REPORT_NOTE_LIMIT,
  claudeResultLink,
  claudeSessionLink,
  type ClaudeReportedStage,
} from '@cockpit/shared';
import type { ToolDefinition } from './create-item.js';

/**
 * The tool Cowork or Claude Code reports a Run's progress with ("Follow on the
 * row what Claude reports back", issue 1160): what it is called, what it says
 * it does, and how its arguments are read. Pure, and proved at L1
 * (tests/unit/mcp/report-run.test.ts); whose Run it may touch is the account's
 * (`command-service.ts`), proved at L2.
 */

export const REPORT_RUN = 'report_run';

export function reportRunTool(): ToolDefinition {
  return {
    name: REPORT_RUN,
    description: [
      "Report how a task Cockpit sent you stands, so the user's Cockpit shows it on the item.",
      'Call it with the run id the prompt names: stage "on_it" when you start (with session_url, the address of this session),',
      '"ready" when you are done (with result_url, a link to what you made, and a note saying what is there),',
      'or "needs_you" when you need an answer (with the question as the note).',
      'You may report again as it changes. Nothing else about the item can be changed this way.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        run: { type: 'string', description: 'The run id named in the prompt.' },
        stage: { type: 'string', enum: [...CLAUDE_REPORTED_STAGES], description: 'Where the task stands.' },
        session_url: {
          type: 'string',
          maxLength: REPORT_LINK_LIMIT,
          description: 'The https address of this session on claude.ai, so the user can open it.',
        },
        result_url: {
          type: 'string',
          maxLength: REPORT_LINK_LIMIT,
          description: 'An https link to what you made.',
        },
        note: {
          type: 'string',
          maxLength: REPORT_NOTE_LIMIT,
          description: 'A short note: what is ready, or the question you need answered.',
        },
      },
      required: ['run', 'stage'],
      additionalProperties: false,
    },
  };
}

export type ReadReport =
  | {
      ok: true;
      runId: string;
      stage: ClaudeReportedStage;
      sessionUrl?: string;
      resultUrl?: string;
      note?: string;
    }
  | { ok: false; refusal: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reads a call's arguments, refusing in words the model can act on. Nothing is stored that was not checked here. */
export function readReport(args: unknown): ReadReport {
  const given = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;

  if (typeof given.run !== 'string' || !UUID.test(given.run.trim())) {
    return { ok: false, refusal: 'run must be the run id the prompt names.' };
  }
  const stage = CLAUDE_REPORTED_STAGES.find((one) => one === given.stage);
  if (!stage) {
    return { ok: false, refusal: `stage must be one of ${CLAUDE_REPORTED_STAGES.map((s) => `"${s}"`).join(', ')}.` };
  }

  const read: ReadReport = { ok: true, runId: given.run.trim().toLowerCase(), stage };
  if (given.session_url !== undefined) {
    const link = claudeSessionLink(given.session_url);
    if (!link) {
      return {
        ok: false,
        refusal: `session_url must be an https address on claude.ai, at most ${REPORT_LINK_LIMIT.toLocaleString('en')} characters.`,
      };
    }
    read.sessionUrl = link;
  }
  if (given.result_url !== undefined) {
    const link = claudeResultLink(given.result_url);
    if (!link) {
      return {
        ok: false,
        refusal: `result_url must be an https address, at most ${REPORT_LINK_LIMIT.toLocaleString('en')} characters.`,
      };
    }
    read.resultUrl = link;
  }
  if (given.note !== undefined) {
    if (typeof given.note !== 'string' || given.note.length > REPORT_NOTE_LIMIT) {
      return { ok: false, refusal: `note must be text of at most ${REPORT_NOTE_LIMIT.toLocaleString('en')} characters.` };
    }
    read.note = given.note;
  }
  return read;
}
