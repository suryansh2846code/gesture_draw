// Downloads the MediaPipe HandLandmarker model into public/models so it can be
// bundled as a web_accessible_resource (we never fetch from Google's CDN at runtime).
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const OUT_DIR = new URL('../public/models/', import.meta.url);
const OUT = new URL('hand_landmarker.task', OUT_DIR);

if (existsSync(OUT)) {
  console.log('✓ model already present:', OUT.pathname);
  process.exit(0);
}
mkdirSync(OUT_DIR, { recursive: true });

console.log('↓ downloading hand_landmarker.task ...');
const res = await fetch(MODEL_URL);
if (!res.ok) {
  console.error('failed to download model:', res.status, res.statusText);
  process.exit(1);
}
await pipeline(Readable.fromWeb(res.body), createWriteStream(OUT));
console.log('✓ saved', OUT.pathname);
