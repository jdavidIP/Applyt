import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dashboard dev server. Proxies /api -> local backend so the browser makes
// same-origin requests in dev (CORS still configured on the backend as a fallback).
const BACKEND_PORT = process.env.BACKEND_PORT ?? '4317';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${BACKEND_PORT}`,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
