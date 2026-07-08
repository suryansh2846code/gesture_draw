// On-device character recognizer — a $P point-cloud matcher (Vatavu, Anthony,
// Wobbrock 2012). Unlike the earlier $1 matcher it is stroke-order and
// stroke-count invariant, so multi-stroke air-writing (A, E, T, 4 …) works and
// the direction you draw in doesn't matter. No ML model, no network.
//
// Templates are plain point clouds, so teach-mode samples (the user's own
// strokes) slot into the exact same structure via setUserTemplates().
import type { Point } from './types';

const N = 32; // points per cloud
const ACCEPT = 0.34; // max $P distance to accept a match (higher = more lenient)

interface PPoint { x: number; y: number; id: number }
interface Template { char: string; pts: PPoint[] }

const dist = (a: PPoint, b: PPoint) => Math.hypot(a.x - b.x, a.y - b.y);

function strokeLen(s: Point[]): number {
  let d = 0;
  for (let i = 1; i < s.length; i++) d += Math.hypot(s[i].x - s[i - 1].x, s[i].y - s[i - 1].y);
  return d;
}

// resample a single stroke to exactly m points, equidistant along its length.
function resampleOne(s: Point[], m: number, id: number): PPoint[] {
  if (s.length === 1) return Array.from({ length: m }, () => ({ x: s[0].x, y: s[0].y, id }));
  const I = strokeLen(s) / (m - 1) || 1;
  const pts = s.map((p) => ({ ...p }));
  const out: PPoint[] = [{ x: pts[0].x, y: pts[0].y, id }];
  let D = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (D + d >= I) {
      const t = (I - D) / d;
      const q = { x: pts[i - 1].x + t * (pts[i].x - pts[i - 1].x), y: pts[i - 1].y + t * (pts[i].y - pts[i - 1].y) };
      out.push({ x: q.x, y: q.y, id });
      pts.splice(i, 0, q);
      D = 0;
    } else D += d;
  }
  while (out.length < m) out.push({ x: s[s.length - 1].x, y: s[s.length - 1].y, id });
  return out.slice(0, m);
}

// resample a whole (multi-stroke) gesture to exactly N points, split across
// strokes by length, without interpolating across the pen-up gaps.
function resampleStrokes(strokes: Point[][]): PPoint[] {
  const strokesNonEmpty = strokes.filter((s) => s.length > 0);
  if (strokesNonEmpty.length === 0) return [];
  const total = strokesNonEmpty.reduce((a, s) => a + strokeLen(s), 0) || 1;
  const counts = strokesNonEmpty.map((s) => Math.max(2, Math.round((N * strokeLen(s)) / total)));
  let sum = counts.reduce((a, c) => a + c, 0);
  // nudge the largest stroke's count so the total is exactly N
  let big = 0;
  for (let i = 1; i < counts.length; i++) if (counts[i] > counts[big]) big = i;
  counts[big] = Math.max(2, counts[big] + (N - sum));
  const out: PPoint[] = [];
  strokesNonEmpty.forEach((s, i) => out.push(...resampleOne(s, counts[i], i)));
  return out.slice(0, N);
}

// uniform scale (aspect preserved so "I" != "O") + translate centroid to origin.
function normalize(pts: PPoint[]): PPoint[] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  const scale = Math.max(maxX - minX, maxY - minY) || 1;
  let cx = 0, cy = 0;
  const s = pts.map((p) => ({ x: (p.x - minX) / scale, y: (p.y - minY) / scale, id: p.id }));
  for (const p of s) { cx += p.x; cy += p.y; }
  cx /= s.length; cy /= s.length;
  return s.map((p) => ({ x: p.x - cx, y: p.y - cy, id: p.id }));
}

function prep(strokes: Point[][]): PPoint[] {
  return normalize(resampleStrokes(strokes));
}

// $P greedy cloud matching: nearest-neighbour assignment weighted by index.
function cloudDistance(pts: PPoint[], tmpl: PPoint[], start: number): number {
  const n = pts.length;
  const matched = new Array<boolean>(n).fill(false);
  let sum = 0;
  let i = start;
  do {
    let min = Infinity, index = -1;
    for (let j = 0; j < n; j++) {
      if (matched[j]) continue;
      const d = dist(pts[i], tmpl[j]);
      if (d < min) { min = d; index = j; }
    }
    matched[index] = true;
    const weight = 1 - ((i - start + n) % n) / n;
    sum += weight * min;
    i = (i + 1) % n;
  } while (i !== start);
  return sum;
}

function greedyMatch(pts: PPoint[], tmpl: PPoint[]): number {
  const n = pts.length;
  const step = Math.max(1, Math.floor(Math.sqrt(n)));
  let min = Infinity;
  for (let i = 0; i < n; i += step) {
    min = Math.min(min, cloudDistance(pts, tmpl, i), cloudDistance(tmpl, pts, i));
  }
  return min / n; // normalize by point count -> comparable across templates
}

// --- template data --------------------------------------------------------
// Single-stroke skeletons (0..100 grid, y down). Good default for digits and
// naturally-single-stroke letters.
const RAW: Record<string, number[][]> = {
  '0': [[50, 6], [22, 20], [8, 50], [22, 80], [50, 94], [78, 80], [92, 50], [78, 20], [50, 6]],
  '1': [[32, 22], [50, 8], [50, 94]],
  '2': [[14, 26], [34, 8], [64, 10], [78, 30], [52, 56], [18, 92], [86, 92]],
  '3': [[16, 18], [56, 8], [74, 30], [48, 50], [74, 70], [54, 92], [14, 80]],
  '5': [[80, 10], [30, 10], [27, 46], [60, 40], [80, 64], [54, 92], [18, 82]],
  '6': [[74, 12], [36, 34], [18, 64], [34, 90], [64, 92], [82, 68], [60, 50], [30, 58]],
  '7': [[14, 12], [86, 12], [44, 94]],
  '8': [[50, 48], [30, 30], [50, 8], [72, 30], [50, 48], [28, 70], [50, 94], [72, 70], [50, 48]],
  '9': [[72, 44], [44, 50], [26, 30], [48, 10], [74, 28], [72, 56], [58, 94]],
  C: [[82, 22], [50, 8], [18, 34], [16, 66], [46, 92], [82, 78]],
  G: [[82, 22], [50, 8], [18, 40], [34, 88], [72, 88], [78, 54], [52, 54]],
  I: [[50, 10], [50, 94]],
  J: [[70, 10], [70, 76], [50, 92], [24, 82]],
  L: [[20, 8], [20, 92], [84, 92]],
  M: [[10, 94], [22, 8], [50, 66], [78, 8], [90, 94]],
  N: [[12, 94], [12, 8], [88, 94], [88, 8]],
  O: [[50, 6], [20, 22], [8, 50], [20, 80], [50, 94], [80, 80], [92, 50], [80, 22], [50, 6]],
  P: [[16, 94], [16, 8], [70, 18], [66, 46], [16, 52]],
  S: [[80, 20], [50, 8], [24, 24], [46, 48], [72, 62], [50, 90], [18, 78]],
  U: [[14, 8], [16, 70], [40, 92], [70, 88], [86, 62], [86, 8]],
  V: [[12, 8], [50, 94], [88, 8]],
  W: [[8, 8], [28, 94], [50, 34], [72, 94], [92, 8]],
  Z: [[16, 12], [86, 12], [18, 92], [88, 92]],
  D: [[16, 8], [16, 94], [60, 84], [86, 50], [60, 16], [16, 8]],
  B: [[16, 8], [16, 94], [66, 78], [24, 50], [70, 30], [16, 8]],
  Q: [[50, 6], [20, 22], [8, 50], [24, 82], [50, 94], [80, 78], [92, 50], [78, 20], [50, 6], [60, 70], [92, 96]],
  R: [[16, 94], [16, 8], [70, 18], [64, 46], [16, 50], [50, 50], [86, 94]],
};

// Multi-stroke variants for glyphs people naturally lift the pen for. $P is
// stroke-count invariant, so both a single- and multi-stroke template can exist
// for the same char and whichever is closer wins.
const MULTI: Record<string, number[][][]> = {
  A: [[[10, 94], [50, 8], [90, 94]], [[28, 56], [72, 56]]],
  E: [[[86, 10], [18, 10], [18, 92], [86, 92]], [[18, 50], [64, 50]]],
  F: [[[86, 10], [18, 10], [18, 94]], [[18, 50], [62, 50]]],
  H: [[[16, 8], [16, 94]], [[84, 8], [84, 94]], [[16, 50], [84, 50]]],
  K: [[[16, 8], [16, 94]], [[80, 10], [16, 52], [84, 94]]],
  T: [[[10, 10], [90, 10]], [[50, 10], [50, 94]]],
  X: [[[12, 10], [88, 92]], [[88, 10], [12, 92]]],
  Y: [[[14, 8], [50, 50], [86, 8]], [[50, 50], [50, 94]]],
  '4': [[[66, 8], [14, 64], [88, 64]], [[66, 8], [66, 94]]],
  '5': [[[80, 10], [30, 10], [28, 46]], [[28, 46], [60, 42], [80, 64], [54, 92], [18, 82]]],
};

const toStroke = (poly: number[][]): Point[] => poly.map(([x, y]) => ({ x, y }));

const SEED: Template[] = [
  ...Object.entries(RAW).map(([char, poly]) => ({ char, pts: prep([toStroke(poly)]) })),
  ...Object.entries(MULTI).map(([char, strokes]) => ({ char, pts: prep(strokes.map(toStroke)) })),
];

// user-taught templates (teach mode), merged in at recognition time.
let USER: Template[] = [];
export function setUserTemplates(list: { char: string; strokes: Point[][] }[]) {
  USER = list.filter((t) => t.strokes.length).map((t) => ({ char: t.char, pts: prep(t.strokes) }));
}

// recognize a (multi-stroke) drawing. null if nothing matches well enough.
export function recognizeStrokes(strokes: Point[][]): { char: string; score: number } | null {
  const clean = strokes.filter((s) => s.length >= 2);
  const totalPts = clean.reduce((a, s) => a + s.length, 0);
  if (totalPts < 3) return null;
  const q = prep(clean);
  let best = { char: '', d: Infinity };
  for (const t of [...SEED, ...USER]) {
    const d = greedyMatch(q, t.pts);
    if (d < best.d) best = { char: t.char, d };
  }
  if (best.d > ACCEPT) return null;
  return { char: best.char, score: 1 - best.d / ACCEPT };
}
