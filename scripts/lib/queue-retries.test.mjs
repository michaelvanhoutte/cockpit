//
// Unit test over apps/api/wrangler.jsonc and apps/api/src/jobs/index.ts: the
// job reads a message's last delivery off `QUEUE_RETRIES`, a copy of the
// consumer's `max_retries` ("Read pasted Teams links", issue 1755). Set lower
// than the copy, no delivery is ever the last and a busy source blocks a
// note's reading for good; set higher, the read gives up early. The queue
// tells a message neither number, so the two are held equal here.
//

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { withoutComments } from './teams-package.mjs';

const wrangler = JSON.parse(withoutComments(readFileSync(new URL('../../apps/api/wrangler.jsonc', import.meta.url), 'utf8')));
const jobs = readFileSync(new URL('../../apps/api/src/jobs/index.ts', import.meta.url), 'utf8');

describe('Capture', () => {
  it("knows a message's last delivery by the retries every environment's queue consumer allows", () => {
    const copied = /export const QUEUE_RETRIES = (\d+);/.exec(jobs);
    assert.ok(copied, 'apps/api/src/jobs/index.ts exports QUEUE_RETRIES as a number');
    const blocks = [wrangler, ...Object.values(wrangler.env ?? {})];
    const consumers = blocks.flatMap((block) => block.queues?.consumers ?? []);
    assert.ok(consumers.length > 0, 'wrangler.jsonc declares a queue consumer');
    for (const consumer of consumers) assert.equal(consumer.max_retries, Number(copied[1]), `${consumer.queue}'s max_retries`);
  });
});
