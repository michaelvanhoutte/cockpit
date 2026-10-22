//
// The real-device gate (scripts/lib/real-device.mjs), from "Fail the Checks
// job when an outside service has no live contract case, and hold a pull
// request whose real-device check was not done" (issue 1426): /build does not
// mark a pull request ready while a real-device line has no result.
//

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { realDeviceGate } from './real-device.mjs';

const walk = (...lines) => ['## Walk', '', ...lines, '', '## Review'].join('\n');

describe('a pull request is not marked ready while a real-device line has no result', () => {
  it('allows a body with no real-device line', () => {
    assert.deepEqual(realDeviceGate(walk('Open Write, type a note, see it filed.')), { ok: true, refusals: [] });
  });

  it('allows a real-device line naming the device and what happened', () => {
    const gate = realDeviceGate(walk('Real device: Pixel 8, Chrome - dictated "buy milk" twice, each written once.'));
    assert.deepEqual(gate, { ok: true, refusals: [] });
  });

  it('refuses a real-device line with no result, quoting the line', () => {
    for (const line of ['Real device: Pixel 8, Chrome', 'Real device: Pixel 8, Chrome - ', 'Real device: Pixel 8 - TODO', 'Real device: <device> - <what happened>']) {
      const gate = realDeviceGate(walk(line));
      assert.equal(gate.ok, false, line);
      assert.equal(gate.refusals.length, 1, line);
      assert.ok(gate.refusals[0].includes(line.trim()), line);
    }
  });

  it('refuses two lines when one has no result, quoting that one only', () => {
    const done = 'Real device: Pixel 8 - dictation wrote the sentence once.';
    const undone = 'Real device: iPhone 15, Safari';
    const gate = realDeviceGate(walk(done, undone));
    assert.equal(gate.ok, false);
    assert.equal(gate.refusals.length, 1);
    assert.ok(gate.refusals[0].includes(undone));
    assert.ok(!gate.refusals[0].includes('Pixel 8'));
  });

  it('allows prose mentioning a phone that is not the marked line form', () => {
    const gate = realDeviceGate(walk('The dictation bug only shows on a real device, so check an Android phone.', 'Tried it on a real device: it worked.'));
    assert.deepEqual(gate, { ok: true, refusals: [] });
  });

  it('refuses when the body cannot be read, saying so', () => {
    const gate = realDeviceGate(null);
    assert.equal(gate.ok, false);
    assert.match(gate.refusals[0], /could not read the pull request body/);
  });

  it('reads the line in a list item and with Windows line endings', () => {
    assert.equal(realDeviceGate('- Real device: Pixel 8\r\n').ok, false);
    assert.equal(realDeviceGate('- Real device: Pixel 8 — worked\r\n').ok, true);
  });
});
