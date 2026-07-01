import { defineConfig } from 'vite';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// Voice-runtime assets that must be served same-origin (mic.js points Silero's
// baseAssetPath/onnxWASMBasePath at '/'): the VAD worklet + model and the ONNX
// Runtime wasm the VAD dynamically imports. They live in node_modules, are too
// large to commit, and must NOT go through Vite's public/ dir — a dynamically
// imported public .mjs trips Vite's `?import` interception in dev and is easy to
// miss in CI. This plugin emits them straight into the build output and serves
// them verbatim in dev, so every `vite build` (root script, package script, or
// Cloudflare's Git build) ships them and on-device inference needs no CDN.
function voiceRuntimeAssets() {
  const require = createRequire(import.meta.url);
  const dist = (pkg) => dirname(require.resolve(pkg)); // entry points sit in each pkg's dist/
  const vad = dist('@ricky0123/vad-web');
  const ort = dist('onnxruntime-web');
  const ASSETS = [
    { name: 'vad.worklet.bundle.min.js', path: join(vad, 'vad.worklet.bundle.min.js'), type: 'text/javascript' },
    { name: 'silero_vad_v5.onnx', path: join(vad, 'silero_vad_v5.onnx'), type: 'application/octet-stream' },
    { name: 'ort-wasm-simd-threaded.wasm', path: join(ort, 'ort-wasm-simd-threaded.wasm'), type: 'application/wasm' },
    // Emscripten glue — the ORT wasm bundle dynamically imports this at runtime.
    { name: 'ort-wasm-simd-threaded.mjs', path: join(ort, 'ort-wasm-simd-threaded.mjs'), type: 'text/javascript' },
  ];
  const byName = new Map(ASSETS.map((a) => [a.name, a]));

  return {
    name: 'bridle-voice-runtime-assets',
    generateBundle() {
      for (const a of ASSETS) {
        this.emitFile({ type: 'asset', fileName: a.name, source: readFileSync(a.path) });
      }
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = req.url?.split('?')[0].replace(/^\//, '');
        const a = byName.get(name);
        if (!a) {
          return next();
        }
        res.setHeader('Content-Type', a.type);
        res.end(readFileSync(a.path));
      });
    },
  };
}

export default defineConfig({
  base: '/',
  // Two pages: a static landing at '/' and the installable PWA at '/app/'. MPA so
  // each path serves its own document instead of SPA-falling-back to '/'.
  appType: 'mpa',
  plugins: [voiceRuntimeAssets()],
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      input: {
        landing: resolve(import.meta.dirname, 'index.html'),
        app: resolve(import.meta.dirname, 'app/index.html'),
      },
    },
  },
  server: {
    host: true, // reachable from a phone on the LAN during dev
  },
});
