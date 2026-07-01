// Vendored voice-runtime assets that must be served same-origin (not from a CDN):
// the Silero VAD worklet + model and the ONNX Runtime wasm the VAD loads. mic.js
// points baseAssetPath/onnxWASMBasePath at '/', so these live at the PWA root and
// get cached by the service worker for offline, on-device inference.

import { createRequire } from 'node:module';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
// Both packages' entry points sit in their dist/ dir, alongside these assets.
const dist = (pkg) => dirname(require.resolve(pkg));

const publicDir = join(dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), '..', 'public');
mkdirSync(publicDir, { recursive: true });

const vad = dist('@ricky0123/vad-web');
const ort = dist('onnxruntime-web');
const assets = [
  [join(vad, 'vad.worklet.bundle.min.js'), 'vad.worklet.bundle.min.js'],
  [join(vad, 'silero_vad_v5.onnx'), 'silero_vad_v5.onnx'],
  [join(ort, 'ort-wasm-simd-threaded.wasm'), 'ort-wasm-simd-threaded.wasm'],
  // Emscripten glue — the bundle usually inlines it, but serve it too in case ORT
  // resolves it from wasmPaths, so we never 404 on a first-run fetch.
  [join(ort, 'ort-wasm-simd-threaded.mjs'), 'ort-wasm-simd-threaded.mjs'],
];

for (const [from, name] of assets) {
  copyFileSync(from, join(publicDir, name));
  console.log(`copied ${name}`);
}
