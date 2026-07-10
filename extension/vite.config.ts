import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.config';

export default defineConfig({
  plugins: [crx({ manifest })],
  server: {
    // Fixed port so the crx dev-server HMR websocket the manifest expects is stable.
    port: 5174,
    strictPort: true,
  },
});
