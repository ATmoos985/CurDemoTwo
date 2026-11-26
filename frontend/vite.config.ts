import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  base: '/app/',
  build: {
    outDir: path.resolve(__dirname, '../src/main/resources/static/app'),
    emptyOutDir: true,
    assetsDir: 'assets',
    commonjsOptions: {
      include: [/node_modules/, /src[\\/]vendor[\\/]/],
      transformMixedEsModules: true
    }
  }
});
