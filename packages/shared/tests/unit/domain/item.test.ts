import { describe, expect, it } from 'vitest';
import {
  LABEL_LENGTH,
  itemDescriptionSchema,
  itemLabel,
  itemTitleSchema,
  workspaceNameSchema,
} from '../../../src/domain/item.js';

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

/**
 * L1: what a row shows is a pure decision over an Item's three texts, worked
 * out where the row is drawn rather than stored, so this is where it is
 * decided. That a row actually asks it is one case in
 * apps/web/tests/unit/components/ItemRow.test.tsx.
 */
describe('Item editing', () => {
  describe('a row shows the next action, or the title, or the start of the captured message', () => {
    const texts = (over: Partial<Parameters<typeof itemLabel>[0]>) => ({
      nextAction: null,
      title: '',
      capturedMessage: null,
      ...over,
    });

    it.each([
      {
        situation: 'a next action, which wins over both the others',
        item: texts({
          nextAction: 'Reply to Tom',
          title: 'Part 11',
          capturedMessage: 'Tom asked about part 11',
        }),
        shows: 'Reply to Tom',
      },
      {
        situation: 'no next action but a title',
        item: texts({ title: 'Part 11', capturedMessage: 'Tom asked about part 11' }),
        shows: 'Part 11',
      },
      {
        situation: 'neither, so the captured message stands in',
        item: texts({ capturedMessage: 'Tom asked about part 11' }),
        shows: 'Tom asked about part 11',
      },
      // Blank is absent, or a title of spaces would leave the row unreadable
      // while a perfectly good captured message sat behind it.
      {
        situation: 'a title of nothing but blanks',
        item: texts({ title: '   ', capturedMessage: 'Tom asked about part 11' }),
        shows: 'Tom asked about part 11',
      },
      {
        situation: 'a next action of nothing but blanks',
        item: texts({ nextAction: ' ', title: 'Part 11' }),
        shows: 'Part 11',
      },
      {
        situation: 'nothing written anywhere',
        item: texts({}),
        shows: '',
      },
      // A captured message runs to paragraphs and a row is one line, so the cut
      // has to land in the label a person sees.
      {
        situation: 'a captured message written over several lines',
        item: texts({ capturedMessage: 'Ask Tom\n\n  about part 11\t' }),
        shows: 'Ask Tom about part 11',
      },
      {
        situation: 'a captured message of exactly the length that fits',
        item: texts({ capturedMessage: 'x'.repeat(LABEL_LENGTH) }),
        shows: 'x'.repeat(LABEL_LENGTH),
      },
      {
        situation: 'a captured message one character too long',
        item: texts({ capturedMessage: 'x'.repeat(LABEL_LENGTH + 1) }),
        shows: `${'x'.repeat(LABEL_LENGTH)}…`,
      },
    ])('$situation', ({ item, shows }) => {
      expect(itemLabel(item)).toBe(shows);
    });
  });

  describe('a title is a single line, and a description is as long as it needs to be', () => {
    it.each([
      { situation: 'a title over the limit', schema: 'title', typed: 'x'.repeat(201), accepted: false },
      { situation: 'a title at the limit', schema: 'title', typed: 'x'.repeat(200), accepted: true },
      { situation: 'a title of nothing at all', schema: 'title', typed: '', accepted: true },
      // Trimmed before it is measured, so trailing blanks are not what puts a
      // title over: they are not stored either.
      { situation: 'a title at the limit with blanks around it', schema: 'title', typed: `  ${'x'.repeat(200)}  `, accepted: true },
      { situation: 'a title broken over two lines', schema: 'title', typed: 'Part\n11', accepted: false },
      { situation: 'a description over several lines', schema: 'description', typed: 'One\n\nTwo', accepted: true },
      { situation: 'a description over the limit', schema: 'description', typed: 'x'.repeat(60_001), accepted: false },
      { situation: 'a description at the limit', schema: 'description', typed: 'x'.repeat(60_000), accepted: true },
    ])('$situation', ({ schema, typed, accepted }) => {
      const of = schema === 'title' ? itemTitleSchema : itemDescriptionSchema;
      expect(of.safeParse(typed).success).toBe(accepted);
    });
  });
});
