import { beforeEach, afterEach, describe, expect, inject, it, vi } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import type { CommandName, CommandPayload } from '@cockpit/shared';
import {
  ACCOUNT_NAME,
  DASHBOARD_ID,
  OTHER_ACCOUNT_NAME,
  OTHER_USER_ID,
  TASK_TYPE_ID,
  WORKSPACE_ID,
  asUser,
  inStoreAsItIs,
  inTheStore,
  seedRegister,
  signInAs,
  startFromEmpty,
} from '../seed.js';
import { handleQueue } from '../../../src/jobs/index.js';
import type { EnrichmentJob } from '../../../src/jobs/enrichment.js';

/**
 * Integration level: a real store, and the job runs through the real queue
 * consumer (`handleQueue`, the same entry point the runtime calls), for the
 * reason `note-cleanup.test.ts` beside this file is - the model is the one
 * horizontal dependency, faked at the network boundary ("Show what the
 * system learned, in a sentence you can correct", issue 301). Whether the
 * real model writes a summary worth reading is the contract tier's question
 * (tests/contract/summarize-filing-patterns.v1.test.ts).
 */

const A_SUMMARY = {
  summary:
    'You file sign-off and audit-trail questions to Compliance questions, even when they name a person.',
};

type Answering = { says: unknown } | 'fails' | 'declines';

let asked: { system: string }[] = [];

function theModelIs(answering: Answering): void {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.hostname !== 'api.anthropic.com') {
      throw new Error(`the suite tried to reach ${url.origin}`);
    }

    const sent = JSON.parse(
      input instanceof Request ? await input.clone().text() : String(init?.body ?? '{}'),
    ) as { system: string };
    asked.push({ system: sent.system });

    if (answering === 'fails') throw new Error('the model could not be reached');
    return Response.json({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5',
      content: answering === 'declines' ? [] : [{ type: 'text', text: JSON.stringify(answering.says) }],
      stop_reason: answering === 'declines' ? 'refusal' : 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  });
}

async function postChange<N extends CommandName>(name: N, payload: CommandPayload<N>) {
  return asUser(`http://cockpit.test/v1/commands/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

let seq = 0;
function nextId(): string {
  seq += 1;
  return `018f0000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
}

async function aPanel(name: string): Promise<string> {
  const panelId = nextId();
  const response = await postChange('add_panel', {
    commandId: nextId(),
    issuedAt: '2026-09-10T10:00:00.000Z',
    workspaceId: WORKSPACE_ID,
    dashboardId: DASHBOARD_ID,
    panelId,
    name,
    kind: 'items',
  });
  expect(response.status).toBe(200);
  return panelId;
}

/** A settled filing, which is what writes a decision-history entry - the input this job reads. */
async function aFiledNote(message: string, panelId: string): Promise<void> {
  const itemId = nextId();
  expect(
    (
      await postChange('capture_item', {
        commandId: nextId(),
        issuedAt: '2026-09-10T10:00:00.000Z',
        workspaceId: WORKSPACE_ID,
        itemId,
        message,
        typeId: TASK_TYPE_ID,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await postChange('move_item_to_panel', {
        commandId: nextId(),
        issuedAt: '2026-09-10T10:00:01.000Z',
        workspaceId: WORKSPACE_ID,
        itemId,
        panelId,
        order: [itemId],
      })
    ).status,
  ).toBe(200);
}

async function rowFor(accountName: string, workspaceId: string) {
  const rows = await inStoreAsItIs(accountName, (sql) =>
    sql
      .exec<{
        summary: string | null;
        summary_generated_at: string | null;
        correction: string | null;
      }>(
        'SELECT summary, summary_generated_at, correction FROM workspace_routing_summary WHERE tenant_id = ? AND workspace_id = ?',
        accountName,
        workspaceId,
      )
      .toArray(),
  );
  return rows[0] ?? null;
}

function batchOf(job: EnrichmentJob) {
  const message = {
    id: 'message-1',
    timestamp: new Date(),
    body: job as unknown,
    attempts: 1,
    ack: () => {},
    retry: () => {},
  };
  return {
    queue: 'cockpit-enrichment',
    messages: [message],
    ackAll: () => {},
    retryAll: () => {},
  } as unknown as Parameters<typeof handleQueue>[0];
}

const summarizeWorkspace = (accountName = ACCOUNT_NAME, workspaceId = WORKSPACE_ID) =>
  handleQueue(batchOf({ kind: 'summarize-workspace', accountName, workspaceId }), env);

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  asked = [];
  env.ANTHROPIC_API_KEY = 'a-key-that-proves-nothing-here';
  await signInAs();
  await signInAs(OTHER_USER_ID);
  theModelIs({ says: A_SUMMARY });
});

afterEach(() => {
  env.ANTHROPIC_API_KEY = '';
  vi.unstubAllGlobals();
});

describe('What Cockpit has learned', () => {
  describe('the nightly job rewrites a workspace’s summary from its decision history', () => {
    it('writes the summary, leaving no correction touched', async () => {
      const compliance = await aPanel('Compliance questions');
      await aFiledNote('part 11 audit trail question', compliance);

      await summarizeWorkspace();

      const row = await rowFor(ACCOUNT_NAME, WORKSPACE_ID);
      expect(row?.summary).toBe(A_SUMMARY.summary);
      expect(row?.summary_generated_at).not.toBeNull();
      expect(row?.correction).toBeNull();
    });

    it('reads the decision history into the call', async () => {
      const compliance = await aPanel('Compliance questions');
      await aFiledNote('part 11 audit trail question', compliance);
      // The capture above already spent one call of its own (`clean-up-a-note`,
      // over the empty history a fresh Item reads) - reset so `asked[0]` below
      // is unambiguously the summarize call under test.
      asked = [];

      await summarizeWorkspace();

      expect(asked[0]!.system).toContain('part 11 audit trail question');
      expect(asked[0]!.system).toContain('Compliance questions');
    });

    it('overwrites an earlier summary, and does not touch a correction already written', async () => {
      await postChange('set_routing_summary_correction', {
        commandId: nextId(),
        issuedAt: '2026-09-10T09:00:00.000Z',
        workspaceId: WORKSPACE_ID,
        correction: 'Sign-off questions go to Laurens.',
      });
      const compliance = await aPanel('Compliance questions');
      await aFiledNote('part 11 audit trail question', compliance);

      await summarizeWorkspace();

      const row = await rowFor(ACCOUNT_NAME, WORKSPACE_ID);
      expect(row?.summary).toBe(A_SUMMARY.summary);
      expect(row?.correction).toBe('Sign-off questions go to Laurens.');
    });

    it('writes nothing, and calls no model, where there is no decision history yet', async () => {
      await summarizeWorkspace();

      expect(asked).toHaveLength(0);
      expect(await rowFor(ACCOUNT_NAME, WORKSPACE_ID)).toBeNull();
    });

    it('writes nothing where the model declines to summarize, leaving any earlier summary standing', async () => {
      const compliance = await aPanel('Compliance questions');
      await aFiledNote('part 11 audit trail question', compliance);
      await summarizeWorkspace();
      theModelIs('declines');
      await inTheStore((sql) =>
        sql.exec(
          "UPDATE workspace_routing_summary SET summary = summary || ' (marker)' WHERE tenant_id = ? AND workspace_id = ?",
          ACCOUNT_NAME,
          WORKSPACE_ID,
        ),
      );

      await summarizeWorkspace();

      expect((await rowFor(ACCOUNT_NAME, WORKSPACE_ID))?.summary).toBe(`${A_SUMMARY.summary} (marker)`);
    });

    it('writes nothing for an account no longer in the register', async () => {
      await summarizeWorkspace('tenant-does-not-exist', WORKSPACE_ID);

      expect(asked).toHaveLength(0);
    });

    /**
     * `delete_workspace` tombstones the Workspace alone (`deleted_at`) rather
     * than removing the row, so the decision history this job reads is still
     * there to read - the race is entirely in the write that follows,
     * exactly as `note-cleanup.test.ts` covers for a Panel and a Workspace
     * deleted while a note is being read.
     */
    it('writes nothing when the workspace itself has gone by the time the write lands', async () => {
      const compliance = await aPanel('Compliance questions');
      await aFiledNote('part 11 audit trail question', compliance);
      expect(
        (
          await postChange('delete_workspace', {
            commandId: nextId(),
            issuedAt: '2026-09-10T10:00:02.000Z',
            workspaceId: WORKSPACE_ID,
          })
        ).status,
      ).toBe(200);
      // The capture above already spent one call of its own; reset so the one
      // call left is unambiguously the summarize call under test.
      asked = [];

      await summarizeWorkspace();

      expect(asked).toHaveLength(1);
      expect(await rowFor(ACCOUNT_NAME, WORKSPACE_ID)).toBeNull();
    });

    it('never reaches another account’s workspace of the same id', async () => {
      const compliance = await aPanel('Compliance questions');
      await aFiledNote('part 11 audit trail question', compliance);

      await summarizeWorkspace(OTHER_ACCOUNT_NAME, WORKSPACE_ID);

      // Their store has no decision history for its own ws-1, so the job
      // found nothing to summarize there - and never touched this account's
      // own row, which is the actual thing under test.
      expect(await rowFor(OTHER_ACCOUNT_NAME, WORKSPACE_ID)).toBeNull();
      expect(await rowFor(ACCOUNT_NAME, WORKSPACE_ID)).toBeNull();
    });
  });
});
