import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RepeatsChoices } from '../../../src/components/RepeatsChip';
import { deviceSpeaks } from '../support/timeZone';

/**
 * F1: the popover's read-back says the days a rule falls on in the order of the
 * viewer's region ("Show every date the app shows in your own time zone and
 * region", issue 1427). What a rule does, and the chip as it works, are
 * RepeatsAtOnce.test.tsx and the browser walk.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

const weekly = { frequency: 'weekly', nextOn: '2026-11-02', dueAfterDays: 5 } as const;

describe('Item editing', () => {
  describe('a repeating rule’s read-back says its days in the order of the viewer’s region', () => {
    it.each([
      { situation: 'nl-BE', languages: ['nl-BE'], reads: 'Weekly on Monday · next Mon, 2 Nov · due Sat, 7 Nov' },
      { situation: 'en-US', languages: ['en-US'], reads: 'Weekly on Monday · next Mon, Nov 2 · due Sat, Nov 7' },
    ])('reads $situation as $reads', ({ languages, reads }) => {
      deviceSpeaks(...languages);

      render(<RepeatsChoices repeat={weekly} onRepeat={() => {}} onSettled={() => {}} refusal={null} />);

      expect(screen.getByText(reads)).toBeVisible();
    });
  });
});
