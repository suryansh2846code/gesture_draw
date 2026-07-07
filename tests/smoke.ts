// Headless smoke test of the DOM-free core: gesture recognition, shape snapping,
// and the 1€ filter. Bundled with esbuild and run in Node (no browser needed).
import { GestureRecognizer, type LM } from '../src/content/gestures';
import { snapStroke } from '../src/content/shapeSnap';
import { OneEuro2D } from '../src/content/OneEuroFilter';
import type { Point } from '../src/content/types';

let pass = 0,
  fail = 0;
function check(name: string, cond: boolean) {
  console.log((cond ? '✓' : '✗ FAIL') + '  ' + name);
  cond ? pass++ : fail++;
}

// --- build a synthetic hand (21 landmarks) ---------------------------------
// baseline open hand: wrist at 0.5,0.9; fingers extended upward.
function openHand(): LM[] {
  const lm: LM[] = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  lm[0] = { x: 0.5, y: 0.9, z: 0 }; // wrist
  lm[9] = { x: 0.5, y: 0.6, z: 0 }; // middle_mcp -> palm size ~0.3
  // extended fingertips (far from wrist) + pip joints (nearer)
  const ext = (tip: number, pip: number, x: number) => {
    lm[pip] = { x, y: 0.55, z: 0 };
    lm[tip] = { x, y: 0.35, z: 0 };
  };
  ext(8, 6, 0.45); // index
  ext(12, 10, 0.5); // middle
  ext(16, 14, 0.55); // ring
  ext(20, 18, 0.6); // pinky
  lm[4] = { x: 0.35, y: 0.6, z: 0 }; // thumb tip away
  return lm;
}

function pinchHand(): LM[] {
  const lm = openHand();
  // thumb tip meets index tip -> pinch; curl middle/ring/pinky (tips near wrist)
  lm[8] = { x: 0.45, y: 0.4, z: 0 };
  lm[4] = { x: 0.452, y: 0.402, z: 0 };
  for (const [tip, pip] of [[12, 10], [16, 14], [20, 18]] as const) {
    lm[pip] = { x: 0.5, y: 0.7, z: 0 };
    lm[tip] = { x: 0.5, y: 0.78, z: 0 }; // curled: tip closer to wrist than pip
  }
  return lm;
}

function fist(): LM[] {
  const lm = openHand();
  for (const [tip, pip] of [[8, 6], [12, 10], [16, 14], [20, 18]] as const) {
    lm[pip] = { x: 0.5, y: 0.7, z: 0 };
    lm[tip] = { x: 0.5, y: 0.8, z: 0 };
  }
  return lm;
}

// --- gesture tests ----------------------------------------------------------
const g = new GestureRecognizer(0.35);
check('open palm -> palm', g.read(openHand()).gesture === 'palm');
check('fist -> fist', new GestureRecognizer().read(fist()).gesture === 'fist');
const gp = new GestureRecognizer(0.35);
check('pinch -> pinch', gp.read(pinchHand()).gesture === 'pinch');
// hysteresis: once pinched, a slightly-open hand stays pinched
const slightlyOpen = pinchHand();
slightlyOpen[4] = { x: 0.41, y: 0.45, z: 0 }; // small gap, within exit band
check('pinch hysteresis holds', gp.read(slightlyOpen).gesture === 'pinch');

// --- shape snapping ---------------------------------------------------------
function circleStroke(): Point[] {
  const pts: Point[] = [];
  for (let a = 0; a <= Math.PI * 2 + 0.1; a += 0.2)
    pts.push({ x: 200 + Math.cos(a) * 80, y: 200 + Math.sin(a) * 80 });
  return pts;
}
function rectStroke(): Point[] {
  return [
    ...seg({ x: 50, y: 50 }, { x: 250, y: 50 }),
    ...seg({ x: 250, y: 50 }, { x: 250, y: 180 }),
    ...seg({ x: 250, y: 180 }, { x: 50, y: 180 }),
    ...seg({ x: 50, y: 180 }, { x: 50, y: 52 }),
  ];
}
function lineStroke(): Point[] {
  return seg({ x: 20, y: 30 }, { x: 300, y: 90 });
}
function seg(a: Point, b: Point): Point[] {
  const out: Point[] = [];
  for (let t = 0; t <= 1; t += 0.05) out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  return out;
}

check('circle snaps to circle', snapStroke(circleStroke(), 'auto', '#f00', 4).kind === 'circle');
check('rectangle snaps to rect', snapStroke(rectStroke(), 'auto', '#f00', 4).kind === 'rect');
check('straight stroke snaps to arrow', snapStroke(lineStroke(), 'auto', '#f00', 4).kind === 'arrow');
check('freehand mode never snaps', snapStroke(circleStroke(), 'free', '#f00', 4).kind === 'free');
check(
  'forced rect mode -> rect',
  snapStroke(lineStroke(), 'rect', '#f00', 4).kind === 'rect',
);

// --- 1€ filter: reduces jitter but tracks the signal ------------------------
const f = new OneEuro2D(1.0, 0.007);
let jitterIn = 0,
  jitterOut = 0;
let prevIn = 100,
  prevOut = 100;
for (let i = 0; i < 60; i++) {
  const noisy = 100 + (Math.random() - 0.5) * 8; // ~±4px jitter around 100
  const out = f.filter(noisy, 100, i * 16.7);
  jitterIn += Math.abs(noisy - prevIn);
  jitterOut += Math.abs(out.x - prevOut);
  prevIn = noisy;
  prevOut = out.x;
}
check('1€ filter reduces jitter', jitterOut < jitterIn * 0.7);
const settled = f.filter(100, 100, 60 * 16.7);
check('1€ filter tracks true value (~100)', Math.abs(settled.x - 100) < 6);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
