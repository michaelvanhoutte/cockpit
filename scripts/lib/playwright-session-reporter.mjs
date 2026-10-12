//
// A Playwright reporter that records the run on the branch's session record
// (scripts/lib/test-run-record.mjs), scoped `E2E`. Listed in
// playwright.config.ts beside the others. It never fails the run.
//

import { recordTestRun } from './test-run-record.mjs';

export default class PlaywrightSessionReporter {
  // Set before the web servers start, which `onBegin` comes after: booting the stack is part of the run.
  start = Date.now();

  onEnd() {
    recordTestRun({ scopes: ['E2E'], start: this.start ?? Date.now(), end: Date.now() });
  }

  printsToStdio() {
    return false;
  }
}
