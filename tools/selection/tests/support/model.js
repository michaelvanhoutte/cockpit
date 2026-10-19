/**
 * Real models for the alarm's tests: built by buildModel from pull requests,
 * so what the alarm reads is what the nightly job would read.
 */

import { buildModel } from '../../src/model.js';

export const NIGHT = new Date('2026-02-15T04:17:00Z');
const MERGED = '2026-02-14T00:00:00Z';

const file = ({ path, status = 'passed' }) => ({ path, level: 'unit', status, selectedBy: null });
const pkg = ({ name = '@cockpit/pkg', dir = 'apps/pkg', mode = 'changed', reason = null, files = [] }) => ({ name, dir, mode, reason, report: 'written', files });
const record = (packages, event = 'pull_request') => ({ event, baseCommit: 'abc123', changedFiles: [], packages });
const forced = (rule, path) => pkg({ mode: 'full', reason: { rule, path } });
const e2eTier = (overrides) => pkg({ name: 'e2e', dir: 'tests/e2e', ...overrides });
const times = (count, make) => Array.from({ length: count }, (_, index) => make(index));

let nextNumber = 1;
function aPull({ test = null, e2e = null, mainFailed = null, mergedAt = MERGED } = {}) {
  const number = nextNumber++;
  return {
    pull: { number, title: `Pull ${number}`, url: `https://github.com/o/r/pull/${number}`, mergedAt },
    prRun: test || e2e ? { id: number * 10, testDurationMs: 60_000, record: test ? record(test) : null, e2eRecord: e2e ? record(e2e) : null } : null,
    mainRun: mainFailed ? { id: number * 10 + 1, testDurationMs: 400_000, record: record([pkg({ mode: 'full', files: [file({ path: mainFailed, status: 'failed' })] })], 'push'), e2eRecord: null } : null,
    files: test || e2e ? null : ['docs/notes.md'],
  };
}

export const MISSED_FILE = 'apps/pkg/tests/unit/missed.test.ts';

/** Twenty pull requests in which no bar is crossed: a hot test selected on 8 of 20. */
export const quiet = () =>
  times(20, (index) =>
    aPull({
      test: [pkg({ files: [file({ path: 'apps/pkg/tests/unit/hot.test.ts', status: index < 8 ? 'passed' : 'not run' })] })],
      e2e: [e2eTier({ mode: 'changed' })],
    }),
  );

/** Twenty pull requests on which E2E ran every spec because no area owns what changed; Test selected throughout. */
export const e2eForcedFull = () =>
  times(20, (index) => aPull({ test: [pkg({ mode: 'changed' })], e2e: [e2eTier(forced('owned by no concept', `apps/api/src/f${index % 2}.ts`))] }));

/** The same, with Test forced to run everything on half of them too: two bars crossed. */
export const bothForcedFull = () =>
  times(20, (index) =>
    aPull({
      test: [index < 10 ? forced('outside every package', 'scripts/x.mjs') : pkg({ mode: 'changed' })],
      e2e: [e2eTier(forced('owned by no concept', `apps/api/src/f${index % 2}.ts`))],
    }),
  );

/** A quiet window in which the last pull request merged a test file its own run skipped and main's run of the merge failed. */
export const withAMiss = () => [...quiet().slice(1), aPull({ test: [pkg({ files: [file({ path: MISSED_FILE, status: 'not run' })] })], e2e: [e2eTier({ mode: 'changed' })], mainFailed: MISSED_FILE })];

/** Too few pull requests for any bar to be read, however bad they look. */
export const tooFew = () => times(5, (index) => aPull({ test: [pkg({ mode: 'changed' })], e2e: [e2eTier(forced('owned by no concept', `apps/api/src/f${index}.ts`))] }));

/** The model of a night: `now` moves the night, and the pull requests stay inside the 14 days around it. */
export const modelOf = (pulls, { alarms = [], now = NIGHT } = {}) => buildModel({ pulls, now, requestedDays: 14, coveredSince: new Date('2026-01-01'), repo: 'o/r', alarms });

/** An alarm issue as the repository holds it, carrying the marker the job writes. */
export const anAlarm = ({ number, bar, state = 'open', first = '2026-02-10', last = '2026-02-14', comments = [], extra = '' }) => ({
  number,
  state,
  title: `Selection: ${bar}`,
  body: `<!-- selection-alarm bar=${bar} first=${first} last=${last} -->\n\nOld figures.\n${extra}`,
  comments,
});
