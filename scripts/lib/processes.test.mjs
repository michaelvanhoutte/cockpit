//
// Unit tests for the process plumbing, run by `node --test` from the Scripts CI
// job — the same place scripts/branch-alias.test.sh is asserted, and for the
// same reason: this is tooling logic outside any package, and a silent change
// in it breaks something that is hard to trace back here.
//
// Fakes rather than real processes throughout. Every branch worth testing is a
// decision about a child's state, not about a child actually running, and a
// suite that spawned real servers to check them would be slower than the thing
// it tests.
//
// Nothing here may depend on the operating system it runs on. Stopping a child
// is the one thing this module does differently per platform, and the first
// version of this file asserted only the POSIX answer — so the Scripts job was
// green on its Linux runner while every one of these was red on the machine
// Cockpit is actually developed on. That is why stopPlan() takes the platform
// instead of reading it, and why supervise() takes stopping as a parameter.
//

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { stopPlan, supervise } from './processes.mjs';

/** A ChildProcess as far as these functions are concerned. */
function fakeChild({ exitCode = null, signalCode = null } = {}) {
  const listeners = new Map();
  return {
    pid: 4242,
    exitCode,
    signalCode,
    on(event, handler) {
      listeners.set(event, handler);
    },
    /** Fire the listener supervise() attached, as Node would on exit. */
    emitExit(code) {
      this.exitCode = code;
      listeners.get('exit')?.(code);
    },
    hasListener(event) {
      return listeners.has(event);
    },
  };
}

describe('stopPlan', () => {
  const platforms = [
    { where: 'on Windows', windows: true },
    { where: 'on POSIX', windows: false },
  ];

  // The guard is the same on both platforms, so it is asserted on both: it is
  // the half that stops a signal reaching whatever inherited a dead pid, and a
  // platform branch added above it would silently take that away on one of them.
  for (const { where, windows } of platforms) {
    it(`leaves a child that already exited alone, ${where}`, () => {
      assert.deepEqual(
        stopPlan(fakeChild({ exitCode: 0 }), windows),
        { do: 'nothing' },
        'signalling a dead pid can hit whatever inherited it',
      );
    });

    it(`leaves a child that was already signalled alone, ${where}`, () => {
      assert.deepEqual(stopPlan(fakeChild({ signalCode: 'SIGTERM' }), windows), { do: 'nothing' });
    });
  }

  it('takes the whole tree down on Windows, where the child is a shell hiding the real server', () => {
    assert.deepEqual(stopPlan(fakeChild(), true), {
      do: 'spawn',
      file: 'taskkill',
      args: ['/pid', '4242', '/T', '/F'],
    });
  });

  it('signals a running child on POSIX, where it shares this process group', () => {
    assert.deepEqual(stopPlan(fakeChild(), false), { do: 'signal', signal: 'SIGTERM' });
  });
});

describe('supervise', () => {
  // supervise() reports a child's failure by setting process.exitCode, which is
  // the right thing for a supervisor and leaks into this test process, whose
  // own exit code is how `node --test` reports the file. So each test that
  // triggers a shutdown asserts the code it expected and then clears it.
  const exitCodeAfterShutdown = () => {
    const code = process.exitCode;
    process.exitCode = 0;
    return code;
  };

  /** Stopping, as far as supervise() is concerned: who was asked, and how often. */
  const recordStops = () => {
    const stopped = [];
    return { stopped, stop: (child) => stopped.push(child) };
  };

  it('stops the others when one exits', () => {
    const first = fakeChild();
    const second = fakeChild();
    const { stopped, stop } = recordStops();
    supervise([first, second], stop);

    first.emitExit(1);

    assert.deepEqual(stopped, [first, second], 'half an application still serving looks healthy and is not');
    assert.equal(exitCodeAfterShutdown(), 1, 'the supervisor carries its child\'s failure out to the caller');
  });

  it('notices a child that died before it was supervised', () => {
    // The window is real: callers start their children one at a time, and
    // anything between the first spawn and the supervise() call can kill one.
    // Node does not replay 'exit' for a listener attached afterwards, so
    // without an explicit check the corpse is watched forever while the rest
    // keep running.
    const dead = fakeChild({ exitCode: 1 });
    const alive = fakeChild();
    const { stopped, stop } = recordStops();

    supervise([dead, alive], stop);

    assert.deepEqual(stopped, [dead, alive]);
    assert.equal(dead.hasListener('exit'), false, 'nothing to wait for on a child that has already gone');
    assert.equal(exitCodeAfterShutdown(), 1);
  });

  it('stops everything once, however many children exit', () => {
    const first = fakeChild();
    const second = fakeChild();
    const { stopped, stop } = recordStops();
    supervise([first, second], stop);

    first.emitExit(1);
    second.emitExit(1);

    assert.deepEqual(stopped, [first, second], 'a second exit must not re-signal what is already stopping');
    exitCodeAfterShutdown();
  });
});
