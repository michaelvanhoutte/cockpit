import { StrictMode, useEffect, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  OpensItemForms,
  useDockedItem,
  useQuietOpening,
  useSettleQuietOpening,
} from '../../src/itemForm';

/**
 * "Let the item's form dock to the side of the screen instead of opening as a
 * dialog" (issue 481): a switch made with `keepFocus` has to be seen by the
 * form it opens, which reads it while mounting. The app renders under
 * `StrictMode`, which may run a `useState` initializer twice in development
 * and expects it to be pure, so the read must give the same answer both times.
 * The router is the only thing replaced here.
 */
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useSearch: () => ({ item: 'item-1' }),
}));

function TheFormOpeningItem2({ settle = false }: { settle?: boolean }) {
  const isQuietOpening = useQuietOpening();
  const settleQuietOpening = useSettleQuietOpening();
  useEffect(() => {
    if (settle) settleQuietOpening();
  }, [settle, settleQuietOpening]);
  const [quiet] = useState(() => isQuietOpening('item-2'));
  // A second read, as StrictMode's own second call of the initializer is.
  const again = isQuietOpening('item-2');
  return <p>{quiet && again ? 'opened quietly' : 'opened loudly'}</p>;
}

function Switcher({ keepFocus, settle }: { keepFocus: boolean; settle: boolean }) {
  const dock = useDockedItem();
  const [switched, setSwitched] = useState(false);
  const [generation, setGeneration] = useState(0);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          dock.show('item-2', keepFocus ? { keepFocus } : undefined);
          setSwitched(true);
        }}
      >
        Switch
      </button>
      <button type="button" onClick={() => setGeneration((was) => was + 1)}>
        Reopen
      </button>
      {switched && <TheFormOpeningItem2 key={generation} settle={settle} />}
    </>
  );
}

const switching = async (keepFocus: boolean, settle = false) => {
  render(
    <StrictMode>
      <OpensItemForms>
        <Switcher keepFocus={keepFocus} settle={settle} />
      </OpensItemForms>
    </StrictMode>,
  );
  await userEvent.setup().click(screen.getByRole('button', { name: 'Switch' }));
};

describe('Item editing', () => {
  describe('a form opened by a switch that keeps the keyboard where it is', () => {
    it('is told so on the render that is committed, and again if asked a second time before it settles', async () => {
      await switching(true);

      expect(screen.getByText('opened quietly')).toBeInTheDocument();
    });

    // A later remount of the same item - history stepping back to it - is not
    // the switch the flag was made for.
    it('is not told so again once the form has settled it and is opened afresh', async () => {
      await switching(true, true);
      expect(screen.getByText('opened quietly')).toBeInTheDocument();

      await userEvent.setup().click(screen.getByRole('button', { name: 'Reopen' }));

      expect(screen.getByText('opened loudly')).toBeInTheDocument();
    });

    it('is not told so for an ordinary switch', async () => {
      await switching(false);

      expect(screen.getByText('opened loudly')).toBeInTheDocument();
    });
  });
});
