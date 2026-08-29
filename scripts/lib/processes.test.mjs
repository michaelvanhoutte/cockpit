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

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { stop, supervise } from './processes.mjs';

/** A ChildProcess as far as these functions are concerned. */
function fakeChild({ exitCode = null, signalCode = null } = {}) {
  const listeners = new Map();
  return {
    pid: 4242,
    exitCode,
    signalCode,
    killed: [],
    on(event, handler) {
      listeners.set(event, handler);
    },
    kill(signal) {
      this.killed.push(signal);
    },
    /** Fire the listener supervise() attached, as Node would on exit. */
    emitExit(code) {
      listeners.get('exit')?.(code);
    },
    hasListener(event) {
      return listeners.has(event);
    },
  };
}

describe('stop', () => {
  it('signals a running child', () => {
    const child = fakeChild();
    stop(child);
    assert.deepEqual(child.killed, ['SIGTERM']);
  });

  it('leaves a child that already exited alone', () => {
    const child = fakeChild({ exitCode: 0 });
    stop(child);
    assert.deepEqual(child.killed, [], 'signalling a dead pid can hit whatever inherited it');
  });

  it('leaves a child that was already signalled alone', () => {
    const child = fakeChild({ signalCode: 'SIGTERM' });
    stop(child);
    assert.deepEqual(child.killed, []);
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

  it('stops the others when one exits', () => {
    const first = fakeChild();
    const second = fakeChild();
    supervise([first, second]);

    first.emitExit(1);

    assert.deepEqual(second.killed, ['SIGTERM'], 'half an application still serving looks healthy and is not');
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

    supervise([dead, alive]);

    assert.deepEqual(alive.killed, ['SIGTERM']);
    assert.equal(dead.hasListener('exit'), false, 'nothing to wait for on a child that has already gone');
    assert.equal(exitCodeAfterShutdown(), 1);
  });

  it('stops everything once, however many children exit', () => {
    const first = fakeChild();
    const second = fakeChild();
    supervise([first, second]);

    first.emitExit(1);
    second.emitExit(1);

    assert.deepEqual(second.killed, ['SIGTERM'], 'a second exit must not re-signal what is already stopping');
    exitCodeAfterShutdown();
  });
});
