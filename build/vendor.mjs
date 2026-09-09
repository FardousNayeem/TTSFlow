#!/usr/bin/env node
/* =========================================================================
   Vendors the Piper neural TTS runtime into piper/vendor/.

   Manifest V3 forbids remote code, and @mintplex-labs/piper-tts-web loads
   both onnxruntime-web and the espeak-ng phonemizer from CDNs at runtime.
   Left alone that fails twice over: the extension CSP blocks it, and AMO
   rejects it. So everything executable is bundled ahead of time and the
   library is pointed at local extension URLs.

     npm install && npm run vendor
   ========================================================================= */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendorDir = path.join(root, 'piper', 'vendor');
const nodeModules = path.join(root, 'node_modules');

const PHONEMIZER_BASE =
  'https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize';

const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;

fs.mkdirSync(vendorDir, { recursive: true });

/* ---------------------------------------------------------------------
   1. espeak-ng phonemizer (JS glue, wasm, and its voice data)
   --------------------------------------------------------------------- */

for (const ext of ['js', 'wasm', 'data']) {
  const dest = path.join(vendorDir, `piper_phonemize.${ext}`);
  if (fs.existsSync(dest)) {
    console.log(`kept     piper_phonemize.${ext.padEnd(5)} ${mb(fs.statSync(dest).size)}`);
    continue;
  }
  process.stdout.write(`fetch    piper_phonemize.${ext} ... `);
  const res = await fetch(`${PHONEMIZER_BASE}.${ext}`);
  if (!res.ok) throw new Error(`${res.status} fetching piper_phonemize.${ext}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  console.log(mb(fs.statSync(dest).size));
}

/* ---------------------------------------------------------------------
   2. ONNX Runtime wasm binary

   Only the single-threaded SIMD build is shipped. Threaded ORT needs
   SharedArrayBuffer, which needs cross-origin isolation, which extension
   pages do not have — so the threaded binaries would only ever fail.
   --------------------------------------------------------------------- */

const ortWasm = path.join(nodeModules, 'onnxruntime-web', 'dist', 'ort-wasm-simd.wasm');
if (!fs.existsSync(ortWasm)) {
  throw new Error('onnxruntime-web not installed — run `npm install` first.');
}
fs.copyFileSync(ortWasm, path.join(vendorDir, 'ort-wasm-simd.wasm'));
console.log(`copied   ort-wasm-simd.wasm  ${mb(fs.statSync(ortWasm).size)}`);

/* ---------------------------------------------------------------------
   3. Bundle the worker

   Two patches are applied to the library on the way through:

   a) It sets ort.env.wasm.numThreads = navigator.hardwareConcurrency.
      Without cross-origin isolation that pulls in the threaded runtime and
      fails, so it is pinned to 1.

   b) Its dynamic import of "onnxruntime-web/wasm" is a bare specifier that
      no browser can resolve; esbuild rewrites it to the real package.
   --------------------------------------------------------------------- */

const applied = { threads: 0, onnxBase: 0, wasmBase: 0 };

const localizeLibrary = {
  name: 'localize-piper-library',
  setup(build) {
    build.onLoad({ filter: /piper-tts-web[\\/]dist[\\/].*\.js$/ }, async (args) => {
      const source = await fs.promises.readFile(args.path, 'utf8');
      let out = source;

      // (a) Pin ORT to one thread — see above.
      const threaded = out;
      out = out.replaceAll('navigator.hardwareConcurrency', '1');
      if (out !== threaded) applied.threads++;

      // (b) Repoint the library's default CDN constants at the vendored
      // copies. These are only fallbacks (every session is handed explicit
      // wasmPaths), but rewriting them means no CDN URL survives in the
      // bundle at all — nothing can quietly fetch remote code, and an AMO
      // reviewer sees none. Root-relative paths resolve against the
      // extension's own origin.
      const onnx = out;
      out = out.replaceAll(
        'https://cdnjs.cloudflare.com/ajax/libs/onnxruntime-web/1.18.0/',
        '/piper/vendor/'
      );
      if (out !== onnx) applied.onnxBase++;

      const wasm = out;
      out = out.replaceAll(
        'https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize',
        '/piper/vendor/piper_phonemize'
      );
      if (out !== wasm) applied.wasmBase++;

      return { contents: out, loader: 'js' };
    });
  }
};

// The Emscripten glue carries require("fs"/"path"/"crypto") calls inside
// ENVIRONMENT_IS_NODE branches. Those branches never run in a worker, but
// esbuild still has to resolve them, so they are stubbed to empty modules.
const stubNodeBuiltins = {
  name: 'stub-node-builtins',
  setup(build) {
    build.onResolve({ filter: /^(fs|path|crypto)$/ }, (args) => ({
      path: args.path,
      namespace: 'node-stub'
    }));
    build.onLoad({ filter: /.*/, namespace: 'node-stub' }, () => ({
      contents: 'export default {};',
      loader: 'js'
    }));
  }
};

const result = await esbuild.build({
  entryPoints: [path.join(root, 'piper', 'worker.src.js')],
  outfile: path.join(root, 'piper', 'worker.js'),
  bundle: true,
  format: 'esm',
  target: 'firefox115',
  platform: 'browser',
  legalComments: 'inline',
  plugins: [localizeLibrary, stubNodeBuiltins],
  metafile: true
});

const bytes = Object.values(result.metafile.outputs)[0].bytes;
console.log(`bundled  piper/worker.js     ${mb(bytes)}`);

for (const [name, count] of Object.entries(applied)) {
  if (count === 0) {
    throw new Error(
      `patch "${name}" matched nothing — the library changed shape; ` +
        'review build/vendor.mjs against the installed version before shipping.'
    );
  }
}

// Fail the build rather than ship something that reaches for remote code.
// Every host left in the bundle must be justified here:
const ALLOWED_HOSTS = {
  // Voice model weights. Data, not code — fetched into OPFS on request.
  'huggingface.co': 'model downloads',
  // A documentation link inside an onnxruntime console.warn string.
  'web.dev': 'diagnostic message only'
};

const bundle = fs.readFileSync(path.join(root, 'piper', 'worker.js'), 'utf8');
const hosts = new Set(
  [...bundle.matchAll(/https:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1].toLowerCase())
);
const unexpected = [...hosts].filter((h) => !(h in ALLOWED_HOSTS));
if (unexpected.length) {
  throw new Error(
    `unexpected hosts in bundle: ${unexpected.join(', ')} — ` +
      'if one of these can load code, vendor it instead of shipping the reference.'
  );
}
console.log(
  `checked  hosts in bundle: ${[...hosts].map((h) => `${h} (${ALLOWED_HOSTS[h]})`).join(', ')}`
);

const total = fs
  .readdirSync(vendorDir)
  .reduce((sum, f) => sum + fs.statSync(path.join(vendorDir, f)).size, bytes);
console.log(`\nvendored total: ${mb(total)}`);
