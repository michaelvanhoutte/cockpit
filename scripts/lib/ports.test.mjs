import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BANDS,
  DOCUMENTED_PORTS,
  OVERRIDES,
  SLOTS,
  howToFreeThePort,
  isLinkedWorktree,
  portsFor,
  slotFor,
} from './ports.mjs';

const A_WORKTREE = 'C:/GitHub/Cockpit/.claude/worktrees/recursing-albattani-4e8f1d';
const ANOTHER = 'C:/GitHub/Cockpit/.claude/worktrees/workspace-color-theming-0d4348';

describe('portsFor', () => {
  it('gives a worktree the same ports every time', () => {
    assert.deepEqual(portsFor(A_WORKTREE, { linked: true }), portsFor(A_WORKTREE, { linked: true }));
  });

  it('answers the same however the path is spelled', () => {
    // On Windows the same worktree is reached as `C:\GitHub\...` from
    // PowerShell and `C:/GitHub/...` from Git Bash. If those disagreed,
    // `pnpm dev` and `pnpm test:e2e` would disagree about this worktree's
    // ports depending on which shell started them.
    const spellings = [
      A_WORKTREE,
      A_WORKTREE.replace(/\//g, '\\'),
      A_WORKTREE.toUpperCase(),
      `${A_WORKTREE}/`,
    ];

    for (const spelling of spellings) {
      assert.equal(slotFor(spelling), slotFor(A_WORKTREE), spelling);
    }
  });

  it('gives two worktrees different ports', () => {
    assert.notDeepEqual(portsFor(A_WORKTREE, { linked: true }), portsFor(ANOTHER, { linked: true }));
  });

  it('leaves the primary checkout on the documented ports', () => {
    assert.deepEqual(portsFor('C:/GitHub/Cockpit', { linked: false }), DOCUMENTED_PORTS);
  });

  it('puts every derived port in its own band', () => {
    const ports = portsFor(A_WORKTREE, { linked: true });

    for (const [which, band] of Object.entries(BANDS)) {
      assert.ok(ports[which] >= band && ports[which] < band + SLOTS, which);
    }
  });

  it('takes a port named by hand over the one it would derive', () => {
    const ports = portsFor(A_WORKTREE, {
      linked: true,
      env: { [OVERRIDES.devWeb]: '4321' },
    });

    assert.equal(ports.devWeb, 4321);
    assert.notEqual(ports.devApi, 4321);
  });

  it('refuses a port named by hand that is not a port', () => {
    // Repairing it would be worse than refusing: `Number('banana')` is NaN, and
    // listening on NaN binds a random free port - which is the one outcome this
    // module exists to prevent, arrived at silently.
    for (const value of ['banana', '0', '70000', '5173.5']) {
      assert.throws(
        () => portsFor(A_WORKTREE, { linked: true, env: { [OVERRIDES.devWeb]: value } }),
        /not a port number/,
        value,
      );
    }
  });
});

describe('every band is clear of the documented ports', () => {
  it('so no worktree can ever land on the primary checkout’s', () => {
    // Over every slot, not a sample: this is the property that lets the primary
    // checkout keep 5173 and 8787 safely, and it is a property of the four
    // numbers in BANDS, which somebody will edit one day.
    const taken = new Set(Object.values(DOCUMENTED_PORTS));

    for (const band of Object.values(BANDS)) {
      for (let slot = 0; slot < SLOTS; slot += 1) {
        assert.ok(!taken.has(band + slot), `band ${band} reaches ${band + slot}`);
      }
    }
  });

  it('and no two bands overlap, so one worktree never collides with itself', () => {
    const bands = Object.values(BANDS).sort((a, b) => a - b);

    for (let at = 1; at < bands.length; at += 1) {
      assert.ok(bands[at] >= bands[at - 1] + SLOTS, `${bands[at - 1]} and ${bands[at]} overlap`);
    }
  });
});

describe('isLinkedWorktree', () => {
  it('reads a worktree from its .git being a file, and the primary from its being a directory', () => {
    assert.equal(isLinkedWorktree('anywhere', { look: () => ({ isFile: () => true }) }), true);
    assert.equal(isLinkedWorktree('anywhere', { look: () => ({ isFile: () => false }) }), false);
  });

  it('calls a checkout it cannot read the primary one, which keeps the known ports', () => {
    assert.equal(
      isLinkedWorktree('anywhere', {
        look: () => {
          throw new Error('ENOENT');
        },
      }),
      false,
    );
  });
});

describe('howToFreeThePort', () => {
  it('says how to give this checkout a port of its own, and does not repeat the complaint', () => {
    const said = howToFreeThePort('devWeb', 5307);

    assert.match(said, /COCKPIT_DEV_WEB_PORT=5308/);
    // The caller has already said which port is in use; saying it again reads
    // as two problems rather than one.
    assert.doesNotMatch(said, /5307 is already in use/);
  });
});
