import {defineConfig} from 'vite';

export default defineConfig({
  // Relative asset base so the compiled bundle works on GitHub Pages subpaths
  // (e.g. https://<user>.github.io/<repo>/) as well as root deployments.
  base: './',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    chunkSizeWarningLimit: 3200,
  },
});
