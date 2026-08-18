import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'frontend',
  base: '/dashboard/',
  plugins: [react()],
  build: {
    outDir: '../public',
    emptyOutDir: true,
  },
});
