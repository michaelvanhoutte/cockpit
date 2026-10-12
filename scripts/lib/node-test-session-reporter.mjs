//
// A Node test-runner reporter that records the run on the branch's session
// record (scripts/lib/test-run-record.mjs). `test:scripts` and `test:lint` list
// it beside `spec`; it prints nothing. The scope is the npm script that ran
// (`test:scripts`), else the directory of the first test path given.
//

import { dirname } from 'node:path';

import { recordTestRun } from './test-run-record.mjs';

/** The scope of a run: its npm script where there is one, else the directory of the first test path on the command line. */
export function nodeTestScope(env, argv) {
  if (env.npm_lifecycle_event) return env.npm_lifecycle_event;
  const first = argv.slice(2).find((arg) => /\.m?[jt]s$/.test(arg) || arg.includes('*'));
  return first ? dirname(first).replaceAll('\\', '/') : 'node-test';
}

export default async function* sessionRunReporter(source) {
  const start = Date.now();
  // The reporter's own loading happens at the run's start; the run is over when the source is.
  for await (const _event of source);
  recordTestRun({ scopes: [nodeTestScope(process.env, process.argv)], start, end: Date.now() });
  yield '';
}
