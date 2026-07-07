// Turn a raw freehand stroke into a clean primitive when it clearly looks like
// one. Heuristic (not ML): fast, predictable, easy to tune.
import type { Point, Shape, ShapeMode } from './types';

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

function pathLength(pts: Point[]): number {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += dist(pts[i - 1], pts[i]);
  return d;
}

function bbox(pts: Point[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

// Ramer–Douglas–Peucker simplification -> count "real" corners.
function rdp(pts: Point[], eps: number): Point[] {
  if (pts.length < 3) return pts;
  let dmax = 0, idx = 0;
  const a = pts[0], b = pts[pts.length - 1];
  for (let i = 1; i < pts.length - 1; i++) {
    const d = perpDist(pts[i], a, b);
    if (d > dmax) { dmax = d; idx = i; }
  }
  if (dmax > eps) {
    const left = rdp(pts.slice(0, idx + 1), eps);
    const right = rdp(pts.slice(idx), eps);
    return left.slice(0, -1).concat(right);
  }
  return [a, b];
}

function perpDist(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1e-6;
  return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
}

export function snapStroke(pts: Point[], mode: ShapeMode, color: string, strokeWidth: number): Shape {
  const free: Shape = { kind: 'free', pts, color, w: strokeWidth };
  if (mode === 'free' || pts.length < 4) return free;

  const box = bbox(pts);
  const diag = Math.hypot(box.w, box.h) || 1;
  const start = pts[0];
  const end = pts[pts.length - 1];
  const closed = dist(start, end) < diag * 0.25;
  const len = pathLength(pts);
  const straightness = dist(start, end) / (len || 1); // ~1 => straight line

  const wantAuto = mode === 'auto';

  // explicit line/arrow, or auto-detected straight stroke
  if (mode === 'line' || mode === 'arrow' || (wantAuto && !closed && straightness > 0.9)) {
    const kind = mode === 'arrow' ? 'arrow' : mode === 'line' ? 'line' : 'arrow';
    return { kind, from: start, to: end, color };
  }

  if (mode === 'circle' || (wantAuto && closed && isRoundish(pts, box))) {
    return {
      kind: 'circle',
      cx: box.minX + box.w / 2,
      cy: box.minY + box.h / 2,
      r: Math.max(box.w, box.h) / 2,
      color,
    };
  }

  if (mode === 'rect' || (wantAuto && closed)) {
    return { kind: 'rect', x: box.minX, y: box.minY, w: box.w, h: box.h, color };
  }

  return free;
}

// circle if the simplified polygon has many corners (smooth) and bbox ~square.
function isRoundish(pts: Point[], box: { w: number; h: number }): boolean {
  const eps = Math.max(box.w, box.h) * 0.08;
  const corners = rdp(pts, eps).length;
  const aspect = box.w / (box.h || 1);
  return corners > 6 && aspect > 0.6 && aspect < 1.7;
}
