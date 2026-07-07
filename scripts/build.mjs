// Bundles the extension with esbuild and assembles dist/.
// Content + background are bundled to IIFE; popup to ESM. WASM + model are copied.
import * as esbuild from 'esbuild';
import { cp, mkdir, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const p = (rel) => fileURLToPath(new URL(rel, root));
const watch = process.argv.includes('--watch');

const OUT = p('dist');

async function clean() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
}

async function copyStatic() {
  // manifest, popup html, icons, models
  await cp(p('public'), OUT, { recursive: true });
  // MediaPipe wasm runtime -> dist/wasm (loaded via chrome.runtime.getURL('wasm'))
  const wasmSrc = p('node_modules/@mediapipe/tasks-vision/wasm');
  if (existsSync(wasmSrc)) {
    await cp(wasmSrc, p('dist/wasm'), { recursive: true });
  } else {
    console.warn('⚠ MediaPipe wasm not found — run npm install first.');
  }
  if (!existsSync(p('public/models/hand_landmarker.task'))) {
    console.warn('⚠ model missing — run `npm run fetch-model` first.');
  }
}

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  sourcemap: true,
  target: ['chrome110'],
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': watch ? '"development"' : '"production"' },
  minify: !watch,
};

const builds = [
  { entryPoints: [p('src/content/bridge.ts')], outfile: p('dist/bridge.js'), format: 'iife' },
  { entryPoints: [p('src/content/engine.ts')], outfile: p('dist/engine.js'), format: 'iife' },
  { entryPoints: [p('src/background/sw.ts')], outfile: p('dist/sw.js'), format: 'iife' },
  { entryPoints: [p('src/popup/popup.ts')], outfile: p('dist/popup.js'), format: 'esm' },
];

async function run() {
  await clean();
  await copyStatic();
  if (watch) {
    for (const b of builds) {
      const ctx = await esbuild.context({ ...common, ...b });
      await ctx.watch();
    }
    console.log('👀 watching for changes...');
  } else {
    await Promise.all(builds.map((b) => esbuild.build({ ...common, ...b })));
    console.log('✓ build complete -> dist/');
    const files = await readdir(OUT);
    console.log('  dist:', files.join(', '));
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
