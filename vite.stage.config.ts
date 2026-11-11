// A plain Vite server for the stage dev page (stage.html): the theatre without the XR runtime, for fast iteration,
// screenshots and fixed-step capture. Not part of the production build.
import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  appType: 'mpa', // a missing asset is a 404, not the main app's index.html
  cacheDir: 'node_modules/.vite-stage',
  publicDir: 'public',
  server: { host: '127.0.0.1', port: 8792, strictPort: true, open: false, watch: { ignored: ['**/qa/**', '**/assets-src/**', '**/hackathon-idea/**', '**/.prod-build/**', '**/public/**', '**/tools/**', '**/docs/**'] } },
  // only the stage page: the main app's entry needs the XR plugin's virtual modules
  optimizeDeps: { entries: ['stage.html'], include: ['three', 'three/examples/jsm/loaders/GLTFLoader.js', 'three/examples/jsm/utils/SkeletonUtils.js'] },
  build: { outDir: 'dist-stage', rollupOptions: { input: 'stage.html' } },
});
