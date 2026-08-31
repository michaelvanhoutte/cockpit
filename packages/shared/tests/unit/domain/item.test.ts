import { describe, expect, it } from 'vitest';
import { workspaceNameSchema } from '../../../src/domain/item.js';

/**
 * L1: which names are refused is a pure decision over a string, so this is
 * where it is decided. That the refusal is reachable through a real request -
 * and comes back as a 400 rather than as a 500 - is one case at the interface,
 * in apps/api/tests/integration/http/workspace-management.test.ts.
 *
 * The characters that are the whole point of some of these cases are invisible,
 * so they are written as escapes rather than typed in: a raw U+2028 in source
 * reads as a space and would be lost in the first reformat.
 */
describe('Workspace management', () => {
  describe('a workspace name is a single line', () => {
    it.each([
      { situation: 'a name broken over two lines', typed: 'Réunions\nand more', accepted: false },
      { situation: 'a name with a tab in it', typed: 'Réunions\tand more', accepted: false },
      // Separators rather than control characters, and a browser breaks the
      // line on them just as readily, so a rule that only looked for control
      // characters let them through.
      {
        situation: 'a name broken with a line separator',
        typed: 'Réunions\u2028and more',
        accepted: false,
      },
      {
        situation: 'a name broken with a paragraph separator',
        typed: 'Réunions\u2029and more',
        accepted: false,
      },
      { situation: 'a name of ordinary text', typed: 'Réunions', accepted: true },
      // The joiner holding an emoji together is invisible too, and is not a
      // line break: refusing it would refuse half the emoji anybody would type.
      {
        situation: 'a name with a joined-up emoji in it',
        typed: '\u{1F468}\u200D\u{1F469}\u200D\u{1F467} Family',
        accepted: true,
      },
    ])('$situation', ({ typed, accepted }) => {
      expect(workspaceNameSchema.safeParse(typed).success).toBe(accepted);
    });
  });

  describe('a workspace name is what you typed with the blanks around it removed', () => {
    // The ends are trimmed and only the interior is refused, which is the line
    // between tidying up what surrounds a name and repairing the name itself.
    it.each([
      { situation: 'blanks on both sides', typed: '  Réunions  ', kept: 'Réunions' },
      { situation: 'a line break on the end', typed: 'Réunions\n', kept: 'Réunions' },
    ])('$situation', ({ typed, kept }) => {
      expect(workspaceNameSchema.parse(typed)).toBe(kept);
    });
  });
});
