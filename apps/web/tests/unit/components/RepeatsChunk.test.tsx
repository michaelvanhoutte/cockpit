import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ItemFormLine } from '../../../src/components/ItemFormLine';

/**
 * F1: the Repeats chip is fetched behind the form's line ("Set an Item to
 * repeat from its form, and see the rule on its row", issue 1406), so a fetch
 * that fails is the line's to answer. The chip as it works is RepeatsAtOnce.test.tsx.
 */

vi.mock('../../../src/components/RepeatsChip', () => {
  throw new Error('Failed to fetch dynamically imported module');
});

afterEach(cleanup);

describe('Item editing', () => {
  describe('a Repeats chip that cannot load says so and leaves the rest of the line as it was', () => {
    it('says it beside the other choices', async () => {
      render(
        <ItemFormLine
          status="to_do"
          priority={null}
          dueDate={null}
          disabled={false}
          onStatus={() => {}}
          onPriority={() => {}}
          onDueDate={() => {}}
          onAttach={() => {}}
          repeats={{ repeat: null, refusal: null, onRepeat: () => {}, onSettled: () => {} }}
        />,
      );

      expect(await screen.findByRole('alert')).toHaveTextContent('Repeats could not load. Reload Cockpit to try again.');
      expect(screen.getByRole('button', { name: /To do/ })).toBeVisible();
    });
  });
});
