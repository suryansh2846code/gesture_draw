// Geometry helpers for the eraser (shapeHit) and pinch-to-select/move
// (pickShape, shapeBBox, translateShape).
import type { Point, Shape } from './types';
import { textWidth } from './draw';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

// index of the topmost (last-drawn) shape within r of p, or -1.
export function pickShape(shapes: Shape[], p: Point, r: number): number {
  for (let i = shapes.length - 1; i >= 0; i--) if (shapeHit(shapes[i], p, r)) return i;
  return -1;
}

export function shapeBBox(s: Shape): Box {
  const xs: number[] = [];
  const ys: number[] = [];
  switch (s.kind) {
    case 'free':
      for (const p of s.pts) {
        xs.push(p.x);
        ys.push(p.y);
      }
      break;
    case 'rect':
      xs.push(s.x, s.x + s.w);
      ys.push(s.y, s.y + s.h);
      break;
    case 'circle':
      xs.push(s.cx - s.r, s.cx + s.r);
      ys.push(s.cy - s.r, s.cy + s.r);
      break;
    case 'line':
    case 'arrow':
      xs.push(s.from.x, s.to.x);
      ys.push(s.from.y, s.to.y);
      break;
    case 'text':
      xs.push(s.x, s.x + textWidth(s));
      ys.push(s.y, s.y + s.h);
      break;
  }
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
}

export function translateShape(s: Shape, dx: number, dy: number): void {
  switch (s.kind) {
    case 'free':
      for (const p of s.pts) {
        p.x += dx;
        p.y += dy;
      }
      break;
    case 'rect':
      s.x += dx;
      s.y += dy;
      break;
    case 'circle':
      s.cx += dx;
      s.cy += dy;
      break;
    case 'line':
    case 'arrow':
      s.from.x += dx;
      s.from.y += dy;
      s.to.x += dx;
      s.to.y += dy;
      break;
    case 'text':
      s.x += dx;
      s.y += dy;
      break;
  }
}

function segDist(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function shapeHit(s: Shape, p: Point, r: number): boolean {
  switch (s.kind) {
    case 'free': {
      for (let i = 1; i < s.pts.length; i++) {
        if (segDist(p, s.pts[i - 1], s.pts[i]) <= r) return true;
      }
      return s.pts.length === 1 ? Math.hypot(p.x - s.pts[0].x, p.y - s.pts[0].y) <= r : false;
    }
    case 'rect': {
      const c: Point[] = [
        { x: s.x, y: s.y },
        { x: s.x + s.w, y: s.y },
        { x: s.x + s.w, y: s.y + s.h },
        { x: s.x, y: s.y + s.h },
      ];
      for (let i = 0; i < 4; i++) if (segDist(p, c[i], c[(i + 1) % 4]) <= r) return true;
      return false;
    }
    case 'circle': {
      const d = Math.hypot(p.x - s.cx, p.y - s.cy);
      return Math.abs(d - s.r) <= r; // near the ring
    }
    case 'line':
    case 'arrow':
      return segDist(p, s.from, s.to) <= r;
    case 'text':
      return (
        p.x >= s.x - r && p.x <= s.x + textWidth(s) + r && p.y >= s.y - r && p.y <= s.y + s.h + r
      );
  }
}
