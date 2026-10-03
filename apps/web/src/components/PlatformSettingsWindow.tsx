import { lazy } from 'react';
import { SettingsModal } from './SettingsModal';

// One chunk each, fetched when its section is first shown, as Settings does
// (`SettingsWindow.tsx`).
const ManageUsers = lazy(() => import('./ManageUsers'));
const UsageWindow = lazy(() => import('./UsageWindow'));

/**
 * Platform settings: who can sign in and what the sign-ins came to, each the
 * content of the window it used to have ("Open Platform settings from the
 * profile menu, as an admin, with users and usage as its sections", issue 694).
 * One modal on the same shell as Settings.
 *
 * **Offered to an admin only, which is a courtesy and not the guard**: what
 * refuses everybody else is the server (`auth/admin.ts`), as it did when these
 * were on the workspace's "…".
 */
export default function PlatformSettingsWindow({
  onClose,
  returnFocusTo,
}: {
  onClose: () => void;
  returnFocusTo?: HTMLElement | null | undefined;
}) {
  return (
    <SettingsModal
      title="Platform settings"
      initial="users"
      onClose={onClose}
      returnFocusTo={returnFocusTo}
      sections={[
        { key: 'users', label: 'Users', content: <ManageUsers open onClose={onClose} /> },
        { key: 'usage', label: 'Usage', content: <UsageWindow open onClose={onClose} /> },
      ]}
    />
  );
}
