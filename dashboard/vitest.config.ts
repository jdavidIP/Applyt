import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts (dev-server only) to keep prod build config lean.
export default defineConfig({
  test: {
    environment: 'node',
  },
});
