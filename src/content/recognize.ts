// On-device single-stroke character recognizer (a $1-style template matcher).
// Each drawn stroke is resampled to a fixed number of points, uniformly scaled
// (aspect preserved so "I" != "O") and centered, then compared to a set of glyph
// templates by mean point distance. No ML model, no network.
import type { Point } from './types';

const N = 48; // resample count
const ACCEPT = 0.28; // max mean point distance (normalized) to accept a match

function pathLength(pts: Point[]): number {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return d;
}

function resample(pts: Point[], n: number): Point[] {
  if (pts.length < 2) return pts.slice();
  const I = pathLength(pts) / (n - 1);
  const out: Point[] = [{ ...pts[0] }];
  let D = 0;
  const p = pts.map((q) => ({ ...q }));
  for (let i = 1; i < p.length; i++) {
    const d = Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
    if (D + d >= I) {
      const t = I === 0 ? 0 : (I - D) / d;
      const q = { x: p[i - 1].x + t * (p[i].x - p[i - 1].x), y: p[i - 1].y + t * (p[i].y - p[i - 1].y) };
      out.push(q);
      p.splice(i, 0, q);
      D = 0;
    } else {
      D += d;
    }
  }
  while (out.length < n) out.push({ ...pts[pts.length - 1] });
  return out.slice(0, n);
}

// uniform scale (aspect preserved) to fit a unit box, centered on the centroid.
function normalize(pts: Point[]): Point[] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  const scale = Math.max(maxX - minX, maxY - minY) || 1;
  let cx = 0, cy = 0;
  const s = pts.map((p) => ({ x: (p.x - minX) / scale, y: (p.y - minY) / scale }));
  for (const p of s) { cx += p.x; cy += p.y; }
  cx /= s.length; cy /= s.length;
  return s.map((p) => ({ x: p.x - cx, y: p.y - cy }));
}

function meanDist(a: Point[], b: Point[]): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.hypot(a[i].x - b[i].x, a[i].y - b[i].y);
  return d / a.length;
}

function prep(pts: Point[]): Point[] {
  return normalize(resample(pts, N));
}

// Templates: single-stroke skeletons in a 0..100 grid (y down), authored as you'd
// air-write each glyph in one motion. Digits are the most reliable; letters are a
// best-effort starter set and can be extended.
const RAW: Record<string, number[][]> = {
  '0': [[50, 6], [22, 20], [8, 50], [22, 80], [50, 94], [78, 80], [92, 50], [78, 20], [50, 6]],
  '1': [[32, 22], [50, 8], [50, 94]],
  '2': [[14, 26], [34, 8], [64, 10], [78, 30], [52, 56], [18, 92], [86, 92]],
  '3': [[16, 18], [56, 8], [74, 30], [48, 50], [74, 70], [54, 92], [14, 80]],
  '4': [[66, 8], [12, 66], [88, 66], [66, 66], [66, 94]],
  '5': [[80, 10], [30, 10], [27, 46], [60, 40], [80, 64], [54, 92], [18, 82]],
  '6': [[74, 12], [36, 34], [18, 64], [34, 90], [64, 92], [82, 68], [60, 50], [30, 58]],
  '7': [[14, 12], [86, 12], [44, 94]],
  '8': [[50, 48], [30, 30], [50, 8], [72, 30], [50, 48], [28, 70], [50, 94], [72, 70], [50, 48]],
  '9': [[72, 44], [44, 50], [26, 30], [48, 10], [74, 28], [72, 56], [58, 94]],
  A: [[10, 94], [50, 8], [90, 94], [70, 55], [30, 55]],
  B: [[16, 8], [16, 94], [66, 78], [24, 50], [70, 30], [16, 8]],
  C: [[82, 22], [50, 8], [18, 34], [16, 66], [46, 92], [82, 78]],
  D: [[16, 8], [16, 94], [60, 84], [86, 50], [60, 16], [16, 8]],
  E: [[84, 10], [18, 10], [18, 50], [64, 50], [18, 50], [18, 92], [86, 92]],
  F: [[86, 10], [18, 10], [18, 50], [62, 50], [18, 50], [18, 94]],
  G: [[82, 22], [50, 8], [18, 40], [34, 88], [72, 88], [78, 54], [52, 54]],
  H: [[16, 8], [16, 94], [16, 50], [84, 50], [84, 8], [84, 94]],
  I: [[50, 10], [50, 94]],
  J: [[70, 10], [70, 76], [50, 92], [24, 82]],
  K: [[16, 8], [16, 94], [16, 52], [82, 10], [40, 46], [84, 94]],
  L: [[20, 8], [20, 92], [84, 92]],
  M: [[10, 94], [22, 8], [50, 66], [78, 8], [90, 94]],
  N: [[12, 94], [12, 8], [88, 94], [88, 8]],
  O: [[50, 6], [20, 22], [8, 50], [20, 80], [50, 94], [80, 80], [92, 50], [80, 22], [50, 6]],
  P: [[16, 94], [16, 8], [70, 18], [66, 46], [16, 52]],
  Q: [[50, 6], [20, 22], [8, 50], [24, 82], [50, 94], [80, 78], [92, 50], [78, 20], [50, 6], [60, 70], [92, 96]],
  R: [[16, 94], [16, 8], [70, 18], [64, 46], [16, 50], [50, 50], [86, 94]],
  S: [[80, 20], [50, 8], [24, 24], [46, 48], [72, 62], [50, 90], [18, 78]],
  T: [[10, 10], [90, 10], [50, 10], [50, 94]],
  U: [[14, 8], [16, 70], [40, 92], [70, 88], [86, 62], [86, 8]],
  V: [[12, 8], [50, 94], [88, 8]],
  W: [[8, 8], [28, 94], [50, 34], [72, 94], [92, 8]],
  X: [[12, 10], [88, 92], [50, 50], [88, 10], [12, 92]],
  Y: [[14, 8], [50, 50], [86, 8], [50, 50], [50, 94]],
  Z: [[16, 12], [86, 12], [18, 92], [88, 92]],
};

const TEMPLATES: { char: string; pts: Point[] }[] = Object.entries(RAW).map(([char, pairs]) => ({
  char,
  pts: prep(pairs.map(([x, y]) => ({ x, y }))),
}));

// returns the recognized character, or null if nothing matches well enough.
export function recognizeChar(stroke: Point[]): { char: string; score: number } | null {
  if (stroke.length < 3) return null;
  const q = prep(stroke);
  let best = { char: '', d: Infinity };
  for (const t of TEMPLATES) {
    const d = meanDist(q, t.pts);
    if (d < best.d) best = { char: t.char, d };
  }
  if (best.d > ACCEPT) return null;
  return { char: best.char, score: 1 - best.d / ACCEPT };
}
