import { z } from 'zod';

/**
 * A source account a Workspace has connected - a Microsoft Teams sign-in
 * today, and whatever else is connected later ("Connect a Microsoft Teams
 * source account", issue 485).
 *
 * **The credential is never part of this shape.** It is sealed in the
 * Workspace's own store and read by nothing that answers a browser, so the
 * wire carries only what a row has to say: which source it is, whose account
 * at that source, and when it was connected.
 */
export const TEAMS = 'teams';

/** What a connector is called on screen; its id is what the store keys on. */
export function connectorNamed(connectorId: string): string {
  return connectorId === TEAMS ? 'Microsoft Teams' : connectorId;
}

export const sourceAccountSchema = z.object({
  id: z.string(),
  connectorId: z.string(),
  /**
   * Who the source says this account is - a name where it gave one, the
   * address it signs in with otherwise. Read off the identity the source
   * returned rather than typed here, so two accounts of one source can be
   * told apart in the list.
   */
  displayName: z.string(),
  connectedAt: z.iso.datetime(),
});
export type SourceAccount = z.infer<typeof sourceAccountSchema>;

export const sourceAccountListSchema = z.object({
  sourceAccounts: sourceAccountSchema.array(),
});
export type SourceAccountList = z.infer<typeof sourceAccountListSchema>;
