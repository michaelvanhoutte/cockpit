import { createContext, useContext } from 'react';
import type { SettingsKey } from './components/SettingsWindow';

/**
 * How a window reaches Settings from where it is drawn ("See and change what
 * Cockpit remembers", issue 1164): the shell owns Settings, so a window that
 * wants one section opened asks through this. Absent outside the shell, and a
 * window then offers no way there.
 */
export type OpenSettings = (on: SettingsKey, sentenceId?: string) => void;

export const SettingsOpener = createContext<OpenSettings | null>(null);

export function useOpenSettings(): OpenSettings | null {
  return useContext(SettingsOpener);
}
