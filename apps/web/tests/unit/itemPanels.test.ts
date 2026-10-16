import { describe, expect, it } from 'vitest';
import type { Filing, Panel } from '@cockpit/shared';
import {
  NO_PANEL_EDITS,
  afterAdding,
  afterRemoving,
  panelsFiledOn,
  panelsWithEdits,
  type PanelOn,
} from '../../src/itemPanels';

/** F1: what the Item form's *On panels* field lists, and how its held changes cancel each other out. */

const aPanel = (id: string, kind: Panel['kind'] = 'items'): Panel =>
  ({ id, name: id.toUpperCase(), kind, dashboardId: 'd1' }) as Panel;
const filed = (panelId: string, itemId = 'a'): Filing => ({ panelId, itemId, position: 0 }) as Filing;
const on = (panelId: string): PanelOn => ({ panelId, name: panelId.toUpperCase() });

describe('Item editing', () => {
  describe('the On panels field lists the Panels an Item is filed on', () => {
    it('lists the Panels the Item is filed on, in the order the snapshot holds Panels', () => {
      const panels = [aPanel('x'), aPanel('y'), aPanel('z')];

      expect(panelsFiledOn('a', [filed('z'), filed('x'), filed('y', 'b')], panels)).toEqual([on('x'), on('z')]);
    });

    it('leaves out a Filter that shows the Item and a Panel of text', () => {
      const panels = [aPanel('x'), aPanel('f', 'filter'), aPanel('t', 'text')];

      expect(panelsFiledOn('a', [filed('x'), filed('f'), filed('t')], panels)).toEqual([on('x')]);
    });

    it('lists nothing for an Item filed nowhere', () => {
      expect(panelsFiledOn('a', [filed('x', 'b')], [aPanel('x')])).toEqual([]);
    });
  });

  describe('On panels changes held for Save cancel each other out', () => {
    const held = [on('x')];

    it('shows the Panels held, less those taken off, plus those added', () => {
      const edits = { added: [on('y')], removed: ['x'] };

      expect(panelsWithEdits(held, edits)).toEqual([on('y')]);
    });

    it('adds a Panel not shown, once', () => {
      const once = afterAdding(NO_PANEL_EDITS, held, on('y'));

      expect(afterAdding(once, held, on('y'))).toEqual({ added: [on('y')], removed: [] });
    });

    it('cancels a Panel taken off when it is added again, rather than filing it twice', () => {
      const taken = afterRemoving(NO_PANEL_EDITS, held, 'x');

      expect(afterAdding(taken, held, on('x'))).toEqual(NO_PANEL_EDITS);
    });

    it('drops a Panel added and not yet sent when it is taken off, rather than sending a removal', () => {
      const added = afterAdding(NO_PANEL_EDITS, held, on('y'));

      expect(afterRemoving(added, held, 'y')).toEqual(NO_PANEL_EDITS);
    });

    it('takes a held Panel off once', () => {
      const taken = afterRemoving(NO_PANEL_EDITS, held, 'x');

      expect(afterRemoving(taken, held, 'x')).toEqual({ added: [], removed: ['x'] });
    });
  });
});
