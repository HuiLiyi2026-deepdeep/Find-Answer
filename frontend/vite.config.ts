import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  resolve: {
    alias:
      mode === 'public'
        ? [
            {
              find: /^\.\/pages\/ConnectionsPage$/,
              replacement: fileURLToPath(new URL('./src/pages/ConnectionsPage.public.tsx', import.meta.url)),
            },
          ]
        : [],
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
      '/functions/v1/app': {
        target: 'http://127.0.0.1:4174',
        changeOrigin: true,
      },
    },
  },
}));
