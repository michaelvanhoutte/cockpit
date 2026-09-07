/**
 * What the containers an account is handed are called before anybody names one.
 *
 * **Numbered, because numbering is how the app marks what it gave you.** A
 * plausible name - *Work*, *Personal* - reads as a decision already made and
 * gets left alone; a numbered one reads as an invitation.
 *
 * **Here rather than in either half, because both halves need them.** The API
 * writes these when a workspace, a dashboard or a panel arrives
 * (apps/api/src/accounts/changes.ts and src/domain), and the web reads the
 * workspace's to know whether anybody has started on the account yet
 * (apps/web/src/welcoming.ts). Two copies of a name that has to match is one of
 * them being wrong.
 *
 * Changing one of these changes what a *new* account is given and nothing else:
 * a change that has run is recorded and never runs again, so no account already
 * holding one of these names is renamed by editing this.
 */

export const FIRST_WORKSPACE_NAME = 'Workspace 1';
export const FIRST_DASHBOARD_NAME = 'Dashboard 1';
export const FIRST_PANEL_NAME = 'Panel 1';
