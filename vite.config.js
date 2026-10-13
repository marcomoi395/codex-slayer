import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'frontend',
  base: '/',
  server: { proxy: { '/auth': 'http://localhost:3000' } },
  build: {
    outDir: '../public',
    emptyOutDir: true,
  },
});
