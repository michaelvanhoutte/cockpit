import type { ManifestOptions } from 'vite-plugin-pwa';

const icon = {
  src: '/icon.svg',
  sizes: 'any',
  type: 'image/svg+xml',
};

// Kept out of vite.config.ts so a test can read what the build will emit.
export const manifest: Partial<ManifestOptions> = {
  name: 'Cockpit',
  short_name: 'Cockpit',
  description: 'Unified inbox and dashboards',
  start_url: '/',
  display: 'standalone',
  background_color: '#edebf7',
  theme_color: '#6f62b5',
  icons: [{ ...icon, purpose: 'any maskable' }],
  // The installed app's icon menu: right-click on the Windows taskbar or Start
  // menu, long-press on an Android home screen. Capture is reached from no
  // Workspace, so the page opens on *Any workspace*.
  shortcuts: [
    {
      name: 'Capture',
      short_name: 'Capture',
      description: 'Capture a note',
      url: '/capture',
      icons: [icon],
    },
  ],
};
