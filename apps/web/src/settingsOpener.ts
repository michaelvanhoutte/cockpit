import { createContext, useContext } from 'react';

/**
 * How a window reaches Settings from where it is drawn ("See and change what
 * Cockpit remembers", issue 1164): the shell owns Settings, so a window that
 * wants *What Cockpit remembers* opened on one sentence asks through this.
 * Absent outside the shell, and a window then offers no way there.
 */
export type OpenSettings = (sentenceId: string) => void;

export const SettingsOpener = createContext<OpenSettings | null>(null);

export function useOpenSettings(): OpenSettings | null {
  return useContext(SettingsOpener);
}
