import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// One build per variant, each aliasing `./variant` to the editor being
// measured, so the lazy chunk holds that editor and nothing else.
const variant = process.env.VARIANT ?? 'none';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      './variant': fileURLToPath(new URL(`./src/variant-${variant}.ts`, import.meta.url)),
    },
  },
  build: { outDir: `dist/${variant}`, emptyOutDir: true, reportCompressedSize: false },
});
