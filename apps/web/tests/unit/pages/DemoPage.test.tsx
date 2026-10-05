import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DemoPage } from '../../../src/pages/DemoPage';

/**
 * F1: what the guest demo's own page says where a source would have opened
 * ("Seed Gmail and Teams in the guest demo, with fewer items, opening their
 * links inside Cockpit", issue 773). It needs no router and no account, which
 * is the point of it: it is the same page signed in or out. That *Open ↗*
 * arrives here is tests/unit/itemSource.test.ts's.
 */
describe('Connector management', () => {
  describe('a demo page says where the source would open, with a way back to Cockpit', () => {
    it.each([
      { situation: 'the Gmail page', page: 'gmail', names: 'Gmail' },
      { situation: 'the Teams page', page: 'teams', names: 'Microsoft Teams' },
    ])('$situation', ({ page, names }) => {
      render(<DemoPage page={page} />);

      expect(screen.getByRole('heading', { level: 1 }).textContent).toContain(names);
      expect(screen.getByRole('link', { name: 'Back to Cockpit' }).getAttribute('href')).toBe('/');
    });

    it('opens nothing for an address that names no page, and still offers the way back', () => {
      render(<DemoPage page="whatsapp" />);

      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Nothing opens here');
      expect(screen.getByRole('link', { name: 'Back to Cockpit' }).getAttribute('href')).toBe('/');
    });
  });
});
