import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ownsProject } from './issue-cost.mjs';
import { allRequests, parseLog, readLog, toRow } from './usage-report.mjs';
import { postBatches, summarizeUpload, uploadRows } from './usage-upload.mjs';

const usage = { input_tokens: 3, output_tokens: 5, cache_creation_input_tokens: 7, cache_read_input_tokens: 11 };

const reply = (requestId, timestamp, gitBranch = 'claude/build-1') =>
  JSON.stringify({
    type: 'assistant',
    requestId,
    timestamp,
    gitBranch,
    message: { model: 'claude-sonnet-5-5', usage, content: [{ type: 'text', text: 'SECRET words from the conversation' }] },
  });

const record = (...marks) => marks.map(([time, phase]) => ({ at: time, phase }));

/** One session: a scoping mark at 09:00 and a push at 10:30 on build-1, with requests before, between and after. */
const session = () => [
  { lines: parseLog([reply('req_1', '2026-10-01T10:00:00Z'), reply('req_2', '2026-10-01T11:00:00Z', 'main')].join('\n')), sessionId: 's1', subagent: false },
  { lines: parseLog(reply('req_3', '2026-10-01T11:00:00Z')), sessionId: 's1', subagent: true },
  { lines: parseLog(reply('req_4', '2026-10-01T12:00:00Z')), sessionId: 's1', subagent: false },
];
const marksOf = (branch) => (branch === 'claude/build-1' ? record(['2026-10-01T09:00:00Z', 'scoped'], ['2026-10-01T10:30:00Z', 'pushed']) : []);

describe('Harness Monitor', () => {
  describe("An upload's rows are the hook's rows", () => {
    it('the same log gives the hook\'s rows and categories, marked as an upload', () => {
      const logs = session();
      const hook = allRequests(logs).map((request) => toRow(request, { ranWhere: 'local', marksOf }));
      const upload = uploadRows(logs, { ranWhere: 'local', marksOf });

      assert.deepEqual(
        upload.map(({ source, ...row }) => row),
        hook.map(({ source, ...row }) => row),
      );
      assert.ok(upload.every((row) => row.source === 'upload'));
      assert.ok(hook.every((row) => row.source === 'hook'));
      assert.deepEqual(
        upload.map((row) => row.category),
        ['building', 'scoping-planning', 'after-push', 'after-push'],
      );
    });

    it('a log line that is not JSON is counted as unreadable and leaves the others', () => {
      const { lines, unreadable } = readLog([reply('req_1', '2026-10-01T10:00:00Z'), '{"type":"assis', 'not json'].join('\n'));
      assert.equal(unreadable, 2);
      assert.equal(lines.length, 1);
    });
  });

  describe("Only this repository's logs are uploaded", () => {
    const root = 'C:\\GitHub\\Cockpit';

    it('a log directory of an unrelated folder whose name shares the prefix is skipped', () => {
      assert.equal(ownsProject(root, 'C:\\GitHub\\Cockpit-Backup'), false);
    });

    it('a worktree of this repository is included', () => {
      assert.equal(ownsProject(root, 'C:\\GitHub\\Cockpit\\.claude\\worktrees\\cockpit-multi-panel-removal-bd32fa'), true);
    });

    it('the main checkout is included, and a directory with no readable session is kept', () => {
      assert.equal(ownsProject(root, 'C:\\GitHub\\Cockpit'), true);
      assert.equal(ownsProject(root, null), true);
    });
  });

  describe('The upload says what it did', () => {
    it('a run prints the requests sent, how many were already stored, and the unreadable log lines', async () => {
      const rows = uploadRows(session(), { ranWhere: 'local', marksOf });
      const totals = await postBatches(rows, async (batch) => ({ stored: batch.length - 1, ignored: 1 }));
      const lines = summarizeUpload({ ...totals, unreadable: 4 });

      assert.equal(lines[0], `Sent ${rows.length} requests: ${rows.length - 1} new, 1 already stored.`);
      assert.equal(lines.at(-1), 'Could not read 4 log lines.');
    });

    it('a batch the monitor refuses is counted, and the batches after it still go', async () => {
      const rows = Array.from({ length: 250 }, (_, i) => ({ requestId: `r${i}` }));
      const totals = await postBatches(rows, async (batch) => (batch.length === 200 ? 'rejected' : { stored: batch.length, ignored: 0 }));

      assert.deepEqual(totals, { stored: 50, alreadyStored: 0, refused: 200, failed: null });
      assert.ok(summarizeUpload({ ...totals, unreadable: 0 }).some((line) => line.startsWith('The monitor refused 200 requests')));
    });

    it('a failure stops the run and says so', async () => {
      const rows = Array.from({ length: 250 }, (_, i) => ({ requestId: `r${i}` }));
      const totals = await postBatches(rows, async () => {
        throw new Error('the monitor answered 503');
      });

      assert.equal(totals.stored, 0);
      assert.equal(totals.failed, 'the monitor answered 503');
      assert.ok(summarizeUpload({ ...totals, unreadable: 0 }).some((line) => line.startsWith('Stopped early: the monitor answered 503.')));
    });
  });
});
