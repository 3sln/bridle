import { defineConfig } from 'vite';

// Plain Vite — no framework plugins. dodo/bones/ngin are zero-dep ESM and need
// no transform. The service worker + manifest live in public/ and are copied
// verbatim, so the build stays dependency-light (matching the 3sln ethos).
export default defineConfig({
  base: '/',
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
  server: {
    host: true, // reachable from a phone on the LAN during dev
  },
});
