import { describe, expect, it } from 'vitest';
import { partOf } from '../../src/github';

describe('Harness Monitor', () => {
  describe('a pull request names its issue in a body line that says it is part of one', () => {
    it.each([
      { situation: 'a line naming an issue', body: 'Part of #1241 Group them\n\nMore.', expected: 1241 },
      { situation: 'the line after a summary', body: '## Summary\n\nThings.\n\nPart of #7', expected: 7 },
      { situation: 'no such line', body: '## Summary\n\nCloses nothing.', expected: null },
      { situation: 'no body', body: null, expected: null },
      { situation: 'the words in the middle of a sentence', body: 'This is Part of #9 really', expected: null },
      { situation: 'another repository’s issue', body: 'Part of owner/repo#12', expected: null },
      { situation: 'a fenced code block', body: 'Text\n\n```\nPart of #5\n```\n', expected: null },
      { situation: 'a code block never closed', body: '```md\nPart of #5\n', expected: null },
      { situation: 'inline code', body: 'Write `Part of #5` yourself', expected: null },
      { situation: 'a quote', body: '> Part of #5\n\nand more', expected: null },
      { situation: 'a line after a code block', body: '```\nx\n```\nPart of #6', expected: 6 },
    ])('$situation: $expected', ({ body, expected }) => {
      expect(partOf(body)).toBe(expected);
    });
  });
});
