import { describe, expect, it } from 'vitest';
import { isLaterReadingOf, replacePhrase } from '../../src/dictation';

/**
 * F1, and pure: whether one final reading is the engine's later reading of the
 * last one or a phrase of its own is a decision over two strings. That the
 * Capture form and the Car view act on it is in their component tests.
 */
describe('isLaterReadingOf', () => {
  it.each([
    ['a reading that grows', 'at', 'at a'],
    ['a longer reading from the first word', 'at a', 'at a dark mode'],
    ['the same words again, differently cased and punctuated', 'Add a dark mode.', 'add a dark mode'],
    ['an earlier word revised on the way', 'at a', 'add a dark mode'],
    ['a reading with accented words', 'café au', 'café au lait'],
  ])('holds for %s', (_situation, earlier, reading) => {
    expect(isLaterReadingOf(earlier, reading)).toBe(true);
  });

  it.each([
    ['a different last word', 'buy milk', 'buy eggs now'],
    ['a different word at the same length', 'call mom', 'call dad'],
    ['a different first word at the same length', 'first thing', 'second thing'],
    ['a shorter reading', 'add a dark mode', 'add a'],
    ['a different word in a phrase of one word', 'at', 'add a dark mode'],
    ['two words changed', 'buy some milk', 'buy a lot of eggs'],
    ['nothing earlier', '', 'add a'],
  ])('does not hold for %s', (_situation, earlier, reading) => {
    expect(isLaterReadingOf(earlier, reading)).toBe(false);
  });
});

describe('replacePhrase', () => {
  it('puts the reading in the place of the earlier one at the end of the note', () => {
    expect(replacePhrase('Idea: at a', 'at a', 'add a dark mode')).toBe('Idea: add a dark mode');
  });

  it('adds the reading after the note where the note no longer ends with the earlier one', () => {
    expect(replacePhrase('Idea: changed', 'at a', 'add a dark mode')).toBe('Idea: changed add a dark mode');
  });
});
