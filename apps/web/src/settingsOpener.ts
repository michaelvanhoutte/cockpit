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

/**
 * How the Inbox reaches one connection's history in Settings › Connections
 * ("Inbox: mail you just labelled waits for the five-minute check, or a Check now per connection in Settings: add a ↻ to the Inbox heading that checks them all now", issue
 * 1835): named by the Workspace it belongs to and its id. Absent outside the
 * shell, and the name is then drawn as plain text.
 */
export type OpenConnectionHistory = (workspaceId: string, sourceAccountId: string) => void;

export const ConnectionHistoryOpener = createContext<OpenConnectionHistory | null>(null);

export function useOpenConnectionHistory(): OpenConnectionHistory | null {
  return useContext(ConnectionHistoryOpener);
}
