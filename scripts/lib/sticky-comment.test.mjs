//
// Unit tests for the one-comment-per-workflow behaviour, run by `node --test`
// from the Scripts CI job.
//
// No subprocess is ever started here: upsertSticky takes `gh` as a parameter,
// so these assert the decisions (which comment, edit or post, whose marker)
// against a fake that records what it was asked to do.
//

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { GATE_AUTHOR } from './review-gate.mjs';
import { upsertSticky } from './sticky-comment.mjs';

const GATE = '<!-- cockpit-security-review -->';
const PREVIEW = '<!-- cockpit-preview-url -->';

/** A `gh` that returns the given comment list and records every call. */
function fakeGh(comments = []) {
  const calls = [];
  const gh = (args, input) => {
    calls.push({ args, input });
    if (args[0] === 'api' && args[1]?.endsWith('/comments') && args.includes('--paginate')) {
      return comments.map((c) => JSON.stringify(c)).join('\n');
    }
    return '';
  };
  gh.calls = calls;
  return gh;
}

const comment = (id, login, body) => ({ id, login, body });

describe('upsertSticky', () => {
  it('posts a new note when the pull request has none', () => {
    const gh = fakeGh([comment(1, 'someone', 'unrelated')]);
    assert.deepEqual(upsertSticky({ gh, repo: 'o/r', pr: 5, marker: GATE, body: 'hello' }), {
      action: 'posted',
      id: null,
    });
    assert.ok(gh.calls.some((c) => c.args.includes('POST')));
  });

  it('edits the note it left last time instead of adding another', () => {
    const gh = fakeGh([comment(7, GATE_AUTHOR, `${GATE}\nold verdict`)]);
    assert.deepEqual(upsertSticky({ gh, repo: 'o/r', pr: 5, marker: GATE, body: 'new verdict' }), {
      action: 'edited',
      id: 7,
    });
    const patch = gh.calls.find((c) => c.args.includes('PATCH'));
    assert.match(patch.args.join(' '), /issues\/comments\/7/);
    assert.match(JSON.parse(patch.input).body, /new verdict/);
  });

  it('leaves the other workflow note alone', () => {
    // The collision this exists for: another note from the same bot must not
    // be claimed. The preview deploy was the case that forced it - it matched
    // on author alone, so whichever workflow spoke last became the other's next
    // edit target - and it is kept as the fixture now that workflow is gone,
    // because "some other comment by this bot" is the condition that matters.
    const gh = fakeGh([comment(3, GATE_AUTHOR, `${PREVIEW}\nPreview: https://example`)]);
    assert.equal(upsertSticky({ gh, repo: 'o/r', pr: 5, marker: GATE, body: 'verdict' }).action, 'posted');
  });

  it('finds its own note among several the same bot posted', () => {
    const gh = fakeGh([
      comment(3, GATE_AUTHOR, `${PREVIEW}\nPreview: https://example`),
      comment(4, GATE_AUTHOR, `${GATE}\nold verdict`),
    ]);
    assert.deepEqual(upsertSticky({ gh, repo: 'o/r', pr: 5, marker: GATE, body: 'new' }), {
      action: 'edited',
      id: 4,
    });
  });

  it('writes the marker into the body, so the next run can find it', () => {
    const gh = fakeGh([]);
    upsertSticky({ gh, repo: 'o/r', pr: 5, marker: PREVIEW, body: 'Preview: https://example' });
    const post = gh.calls.find((c) => c.args.includes('POST'));
    assert.ok(JSON.parse(post.input).body.startsWith(PREVIEW));
  });
});
