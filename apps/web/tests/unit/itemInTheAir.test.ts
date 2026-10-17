import { afterEach, describe, expect, it } from 'vitest';
import { carryAcrossSwitch, dragEnded, landItem, liftItem } from '../../src/itemInTheAir';
import { endSelection, pickAll, pickedNow } from '../../src/selection';

const scope = 'dashboard:d1';

const liftedAndCrossed = () => {
  pickAll(scope, ['a', 'b']);
  liftItem('a', null, { ids: ['a', 'b'], scope });
  carryAcrossSwitch(scope);
};

describe('Selection', () => {
  describe('a selection survives the Dashboard switch its own drag made, and only that one', () => {
    afterEach(() => {
      landItem();
      endSelection();
    });

    it('ends when a dragend reaches a row that is still on the page', () => {
      liftedAndCrossed();

      dragEnded();

      expect(pickedNow(scope).size).toBe(0);
    });

    it('is not ended by the end of a drag it was dropped by', () => {
      liftedAndCrossed();

      landItem();
      dragEnded();

      expect([...pickedNow(scope)]).toEqual(['a', 'b']);
    });

    it('stops listening to the document once the drag has landed', () => {
      liftedAndCrossed();
      landItem();

      document.dispatchEvent(new Event('pointermove', { bubbles: true }));

      expect([...pickedNow(scope)]).toEqual(['a', 'b']);
    });

    it('listens again for a second drag', () => {
      liftedAndCrossed();
      landItem();
      liftedAndCrossed();

      document.dispatchEvent(new Event('pointermove', { bubbles: true }));

      expect(pickedNow(scope).size).toBe(0);
    });
  });
});
