import { act } from '@testing-library/react';
import { vi } from 'vitest';
import type { WakeLockApi } from '../../../src/wakeLock';

/** The platform's wake lock: hands out locks the test can inspect and the browser can take back. */
export class FakeLock {
  released = false;
  private listeners: (() => void)[] = [];
  release() {
    this.released = true;
    return Promise.resolve();
  }
  addEventListener(_type: 'release', listener: () => void) {
    this.listeners.push(listener);
  }
  /** What the browser does when the page is hidden. */
  takenBack() {
    this.released = true;
    act(() => this.listeners.forEach((listener) => listener()));
  }
}

/** A browser's wake lock API, and every lock it handed out; `refuses` is battery saver saying no. */
export function aWakeLock(refuses = false) {
  const taken: FakeLock[] = [];
  const api: WakeLockApi = {
    request: vi.fn(() => {
      if (refuses) return Promise.reject(new Error('battery saver'));
      const lock = new FakeLock();
      taken.push(lock);
      return Promise.resolve(lock);
    }),
  };
  return { api: () => api, request: api.request as ReturnType<typeof vi.fn>, taken };
}
