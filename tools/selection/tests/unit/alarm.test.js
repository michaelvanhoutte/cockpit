import { describe, expect, it } from 'vitest';

import { decideAlarms } from '../../src/alarm.js';
import { renderHtml } from '../../src/render/html.js';
import { anAlarm, bothForcedFull, e2eForcedFull, MISSED_FILE, modelOf, quiet, tooFew, withAMiss } from '../support/model.js';

const decide = (pulls, alarms = []) => decideAlarms({ model: modelOf(pulls), alarms });
const kinds = (actions) => actions.map((action) => action.kind);
const only = (actions) => {
  expect(actions).toHaveLength(1);
  return actions[0];
};

describe('Test selection report', () => {
  describe('a crossed bar with no open alarm gets one issue', () => {
    it('E2E forced to run every spec is filed with its figure, threshold, window, rule, worst paths and when it first crossed', () => {
      const issue = only(decide(e2eForcedFull()));
      expect(issue.kind).toBe('create');
      expect(issue.title).toBe('Selection: E2E forced to run every spec on 100% of pull requests');
      expect(issue.body).toContain('<!-- selection-alarm bar=e2e-forced-full first=2026-02-15 last=2026-02-15 -->');
      expect(issue.body).toContain('E2E forced to run every spec: 20 of 20 pull requests (100%), bar 25%, window 2026-02-01 to 2026-02-15');
      expect(issue.body).toContain('the leading rule, "owned by no concept", forced 20 of the 20');
      expect(issue.body).toContain('Worst paths: `apps/api/src/f0.ts` (10), `apps/api/src/f1.ts` (10)');
      expect(issue.body).toContain('Fix: place a file by what imports it');
      expect(issue.body).toContain('**First crossed** 2026-02-15');
      expect(issue.body).toContain('**Last updated** 2026-02-15 by the nightly Selection job');
      expect(issue.body).toContain('https://o.github.io/r/selection/');
      expect(issue.body).toContain('It is a pointer, not a brief: scope it before building.');
    });

    it('a window that is only partly covered says how much of it was', () => {
      const model = modelOf(e2eForcedFull());
      const partial = { ...model, bars: { ...model.bars, partial: true, actualDays: 10.46 } };
      expect(only(decideAlarms({ model: partial, alarms: [] })).body).toContain('window 2026-02-01 to 2026-02-15 (only 10.5 of 14 days covered)');
    });

    it('any miss is an alarm of its own, naming the files that were missed and the pull request that skipped them', () => {
      const issue = only(decide(withAMiss()));
      expect(issue.kind).toBe('create');
      expect(issue.title).toBe('Selection: 1 miss in the 14-day window');
      expect(issue.body).toContain('<!-- selection-alarm bar=misses ');
      expect(issue.body).toContain(`\`${MISSED_FILE}\` (unit), missed on #`);
    });

    it('a pull request title is shown as code, so a mention, a reference or an HTML comment in it does nothing in the issue', () => {
      const model = modelOf(withAMiss());
      model.misses[0].pull.title = 'fix @someone `x` <!-- see #5';
      const { body } = only(decideAlarms({ model, alarms: [] }));
      expect(body).toContain('missed on #');
      expect(body).toContain('`fix @someone x <!-- see #5`');
    });

    it('two crossed bars are two issues, one each', () => {
      const actions = decide(bothForcedFull());
      expect(kinds(actions)).toEqual(['create', 'create']);
      expect(actions.map((action) => action.bar)).toEqual(['e2e-forced-full', 'test-forced-full']);
      expect(actions[1].title).toBe('Selection: Test forced to run everything on 50% of pull requests');
    });

    it('a bar within its threshold files nothing', () => {
      expect(decide(quiet())).toEqual([]);
    });

    it('an open alarm of the retired most-selected bar is left alone: no comment, no edit, nothing filed, and a crossed bar beside it is handled as ever', () => {
      const retired = [{ ...anAlarm({ number: 11, bar: 'most-selected' }), comments: ['an older comment'] }];
      expect(decide(quiet(), retired)).toEqual([]);

      const actions = decide(e2eForcedFull(), retired);
      expect(actions.map((action) => [action.kind, action.bar])).toEqual([['create', 'e2e-forced-full']]);
    });

    it('a bar that could not be read files nothing and says nothing, even beside an alarm that is open', () => {
      expect(decide(tooFew())).toEqual([]);
      expect(decide(tooFew(), [anAlarm({ number: 7, bar: 'e2e-forced-full' })])).toEqual([]);
    });
  });

  describe('a crossed bar with an open alarm has that alarm edited, never duplicated', () => {
    it('the next night the body is replaced with the night’s figures, first crossed is kept and last updated moves', () => {
      const edit = only(decide(e2eForcedFull(), [anAlarm({ number: 7, bar: 'e2e-forced-full', first: '2026-02-10', last: '2026-02-14' })]));
      expect(edit.kind).toBe('edit');
      expect(edit.number).toBe(7);
      expect(edit.body).toContain('<!-- selection-alarm bar=e2e-forced-full first=2026-02-10 last=2026-02-15 -->');
      expect(edit.body).toContain('20 of 20 pull requests (100%)');
      expect(edit.body).toContain('**First crossed** 2026-02-10');
      expect(edit.body).toContain('**Last updated** 2026-02-15');
      expect(edit.body).not.toContain('Old figures');
    });

    it('a job run again the same night edits the issue the first run filed, and files no second one', () => {
      const [filed] = decide(e2eForcedFull());
      const afterTheFirstRun = [{ number: 9, state: 'open', title: filed.title, body: filed.body, comments: [] }];
      const rerun = decide(e2eForcedFull(), afterTheFirstRun);
      expect(kinds(rerun)).toEqual(['edit']);
      expect(rerun[0].number).toBe(9);
      expect(rerun[0].body).toBe(filed.body);
    });

    it('two open alarms for one bar: the newest is edited and the older one is told once which to follow', () => {
      const alarms = [anAlarm({ number: 5, bar: 'e2e-forced-full' }), anAlarm({ number: 8, bar: 'e2e-forced-full' })];
      const actions = decide(e2eForcedFull(), alarms);
      expect(kinds(actions)).toEqual(['edit', 'comment']);
      expect(actions[0].number).toBe(8);
      expect(actions[1].number).toBe(5);
      expect(actions[1].body).toContain('#8');

      const told = [{ ...alarms[0], comments: [actions[1].body] }, alarms[1]];
      expect(kinds(decide(e2eForcedFull(), told))).toEqual(['edit']);
    });

    it('an alarm for another bar is not edited for it: its own bar, within, only gets its own comment', () => {
      const actions = decide(e2eForcedFull(), [anAlarm({ number: 7, bar: 'test-forced-full' })]);
      expect(actions.map((action) => [action.kind, action.bar, action.number])).toEqual([
        ['create', 'e2e-forced-full', undefined],
        ['comment', 'test-forced-full', 7],
      ]);
    });
  });

  describe('a bar back within its threshold gets one comment on its open alarm, which stays open', () => {
    const alarm = (overrides) => anAlarm({ number: 7, bar: 'e2e-forced-full', first: '2026-02-10', last: '2026-02-14', ...overrides });
    const saidWithin = (night) => `<!-- selection-alarm-within bar=e2e-forced-full since=${night} -->\nThe bar is within.`;

    it('the night it is within, one comment says so with the figure, and nothing else is done to the issue', () => {
      const comment = only(decide(quiet(), [alarm()]));
      expect(comment.kind).toBe('comment');
      expect(comment.number).toBe(7);
      expect(comment.body).toContain('within since the night of 2026-02-15');
      expect(comment.body).toContain('E2E forced to run every spec: 0 of 20 pull requests (0%), bar 25%');
    });

    it('the night after, with that comment standing, there is no second one', () => {
      expect(decide(quiet(), [alarm({ last: '2026-02-13', comments: [saidWithin('2026-02-14')] })])).toEqual([]);
    });

    it('a bar that crosses again while the alarm is open has its body edited, and the comment already made stands', () => {
      const actions = decide(e2eForcedFull(), [alarm({ last: '2026-02-12', comments: [saidWithin('2026-02-13')] })]);
      expect(kinds(actions)).toEqual(['edit']);
    });

    it('a second recovery after crossing again gets a comment of its own', () => {
      const crossedAgainSince = alarm({ last: '2026-02-14', comments: [saidWithin('2026-02-12')] });
      expect(kinds(decide(quiet(), [crossedAgainSince]))).toEqual(['comment']);
    });

    it('a bar within with no open alarm gets nothing, even where a closed one exists', () => {
      expect(decide(quiet(), [alarm({ state: 'closed' })])).toEqual([]);
    });
  });

  describe('a closed alarm is never reopened', () => {
    it('a bar that crosses after a person closed its alarm gets a new issue linking the closed one', () => {
      const closed = anAlarm({ number: 7, bar: 'e2e-forced-full', state: 'closed' });
      const issue = only(decide(e2eForcedFull(), [closed]));
      expect(issue.kind).toBe('create');
      expect(issue.body).toContain('**Follows** #7, closed');
      expect(issue.body).toContain('**First crossed** 2026-02-15');
    });

    it('with several closed, the newest is the one linked', () => {
      const issue = only(decide(e2eForcedFull(), [anAlarm({ number: 3, bar: 'e2e-forced-full', state: 'closed' }), anAlarm({ number: 6, bar: 'e2e-forced-full', state: 'closed' })]));
      expect(issue.body).toContain('**Follows** #6');
      expect(issue.body).not.toContain('#3');
    });
  });

  describe('the page links each crossed bar to the alarm that is open for it', () => {
    const strip = (pulls, alarms) => renderHtml(modelOf(pulls, { alarms })).match(/<div class="verdict[^"]*">[\s\S]*?<\/div>\s*(?=<div class="note">)/)?.[0] ?? '';

    it('the model carries the open alarm’s number, the newest where there are two, and no number for a closed one', () => {
      const model = modelOf(e2eForcedFull(), {
        alarms: [
          anAlarm({ number: 5, bar: 'e2e-forced-full' }),
          anAlarm({ number: 8, bar: 'e2e-forced-full' }),
          anAlarm({ number: 9, bar: 'test-forced-full', state: 'closed' }),
        ],
      });
      const numbers = Object.fromEntries(model.bars.items.map((bar) => [bar.id, bar.alarmIssue]));
      expect(numbers).toEqual({ 'e2e-forced-full': 8, 'test-forced-full': null, misses: null });
    });

    it('the strip’s foot links the issue, and says nothing of one where none is open', () => {
      const linked = strip(e2eForcedFull(), [anAlarm({ number: 8, bar: 'e2e-forced-full' })]);
      expect(linked).toContain('Filed as <a href="https://github.com/o/r/issues/8">#8 E2E forced to run every spec</a>');
      expect(linked).toContain('closed by a person');
      expect(strip(e2eForcedFull(), [])).not.toContain('Filed as');
    });

    it('several linked alarms read as a list', () => {
      const linked = strip(bothForcedFull(), [anAlarm({ number: 8, bar: 'e2e-forced-full' }), anAlarm({ number: 9, bar: 'test-forced-full' })]);
      expect(linked).toMatch(/Filed as <a [^>]*>#8 E2E forced to run every spec<\/a> and <a [^>]*>#9 Test forced to run everything<\/a>\./);
    });

    it('an alarm still open for a bar that is within is not advertised as the cause of a crossed one', () => {
      expect(strip(quiet(), [anAlarm({ number: 8, bar: 'e2e-forced-full' })])).not.toContain('Filed as');
    });
  });
});
