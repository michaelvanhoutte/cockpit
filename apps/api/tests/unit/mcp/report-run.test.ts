import { describe, expect, it } from 'vitest';
import { readReport, reportRunTool } from '../../../src/mcp/report-run.js';

/**
 * L1: how a report on a sent Run is read, and what the tool tells the app
 * ("Follow on the row what Claude reports back", issue 1160). Whose Run it may
 * touch, and what it writes, is tests/integration/http/connected-apps.test.ts's.
 */

const RUN = '018f0000-0000-7000-9000-000000000001';

describe('Agents', () => {
  describe('a report is read before anything is stored', () => {
    it('keeps a stage, both links and a note that are safe', () => {
      expect(
        readReport({
          run: RUN,
          stage: 'ready',
          session_url: 'https://claude.ai/code/session_01',
          result_url: 'https://example.com/draft',
          note: 'Two drafts',
        }),
      ).toEqual({
        ok: true,
        runId: RUN,
        stage: 'ready',
        sessionUrl: 'https://claude.ai/code/session_01',
        resultUrl: 'https://example.com/draft',
        note: 'Two drafts',
      });
    });

    it.each([
      { situation: 'no run id', args: { stage: 'on_it' }, names: 'run id' },
      { situation: 'a run id that is no id', args: { run: 'the-run', stage: 'on_it' }, names: 'run id' },
      { situation: 'a stage Cockpit does not take', args: { run: RUN, stage: 'sent' }, names: '"on_it", "ready", "needs_you"' },
      { situation: 'a session link off claude.ai', args: { run: RUN, stage: 'on_it', session_url: 'https://example.com/s' }, names: 'claude.ai' },
      { situation: 'a result link that is a file', args: { run: RUN, stage: 'ready', result_url: 'file:///etc/passwd' }, names: 'https' },
      { situation: 'a result link that is javascript', args: { run: RUN, stage: 'ready', result_url: 'javascript:alert(1)' }, names: 'https' },
      { situation: 'a result link that is plain http', args: { run: RUN, stage: 'ready', result_url: 'http://example.com/x' }, names: 'https' },
      { situation: 'a link over 2,048 characters', args: { run: RUN, stage: 'ready', result_url: 'https://example.com/' + 'a'.repeat(2_048) }, names: '2,048' },
      { situation: 'a note over 1,000 characters', args: { run: RUN, stage: 'ready', note: 'n'.repeat(1_001) }, names: '1,000' },
    ])('refuses , saying what would do', ({ args, names }) => {
      const read = readReport(args);

      expect(read).toMatchObject({ ok: false, refusal: expect.stringContaining(names) });
    });
  });

  describe('the tool tells the app what it may change', () => {
    it('offers only the run, the stage, two links and a note', () => {
      const tool = reportRunTool();

      expect([tool.name, Object.keys(tool.inputSchema.properties), tool.inputSchema.required]).toEqual([
        'report_run',
        ['run', 'stage', 'session_url', 'result_url', 'note'],
        ['run', 'stage'],
      ]);
    });
  });
});
