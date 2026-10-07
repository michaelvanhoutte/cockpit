import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DARK_FLAG, useAppearance } from '../../src/appearance';

afterEach(() => document.documentElement.removeAttribute(DARK_FLAG));

describe('Appearance', () => {
  describe('the shell draws in the appearance the document is flagged in, and follows the flag', () => {
    it('is light until the document is flagged dark, and light again when the flag goes', async () => {
      const { result } = renderHook(() => useAppearance());
      expect(result.current).toBe('light');

      await act(async () => document.documentElement.setAttribute(DARK_FLAG, ''));
      expect(result.current).toBe('dark');

      await act(async () => document.documentElement.removeAttribute(DARK_FLAG));
      expect(result.current).toBe('light');
    });

    it('is dark when the document was flagged before the shell mounted', () => {
      document.documentElement.setAttribute(DARK_FLAG, '');

      expect(renderHook(() => useAppearance()).result.current).toBe('dark');
    });
  });
});
