//
// A Playwright reporter that records the run on the branch's session record
// (scripts/lib/test-run-record.mjs), scoped `E2E`. Listed in
// playwright.config.ts beside the others. It never fails the run.
//

import { recordTestRun } from './test-run-record.mjs';

export default class PlaywrightSessionReporter {
  onBegin() {
    this.start = Date.now();
  }

  onEnd() {
    recordTestRun({ scopes: ['E2E'], start: this.start ?? Date.now(), end: Date.now() });
  }

  printsToStdio() {
    return false;
  }
}
