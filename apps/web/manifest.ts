import type { ManifestOptions } from 'vite-plugin-pwa';

const icon = {
  src: '/icon.svg',
  sizes: 'any',
  type: 'image/svg+xml',
};

/**
 * What the share sheet may offer this app for: the Attachment allowlist
 * (`ATTACHMENT_CONTENT_TYPES`, packages/shared/src/domain/attachment.ts), and
 * the address `SHARE_TARGET_PATH` (packages/shared/src/domain/share.ts).
 *
 * **Written out rather than imported**, because Vite loads this file in Node
 * before any of its own resolution runs, and Node cannot follow the shared
 * package's `.js` specifiers to its `.ts` sources. The manifest test holds both
 * to the originals, so they cannot drift.
 */
const SHARE_TARGET_ADDRESS = '/share-target';
const ATTACHMENT_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'application/pdf',
];

// Kept out of vite.config.ts so a test can read what the build will emit.
export const manifest: Partial<ManifestOptions> = {
  name: 'Cockpit',
  short_name: 'Cockpit',
  description: 'Unified inbox and dashboards',
  start_url: '/',
  display: 'standalone',
  background_color: '#f4f4f2',
  theme_color: '#2d2e35',
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
    {
      name: 'Car capture',
      short_name: 'Car capture',
      description: 'Capture a note by voice, hands free',
      url: '/capture/car',
      icons: [icon],
    },
  ],
  // Android's share sheet offers the installed app for what an Attachment
  // accepts, and for text and links. The service worker keeps what arrives and
  // opens Capture on it (public/share-target-sw.js).
  share_target: {
    action: SHARE_TARGET_ADDRESS,
    method: 'POST',
    enctype: 'multipart/form-data',
    params: {
      title: 'title',
      text: 'text',
      url: 'url',
      files: [{ name: 'files', accept: ATTACHMENT_TYPES }],
    },
  },
};
