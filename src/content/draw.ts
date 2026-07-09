// Shared drawing primitives, used by both the screen overlay (Renderer) and the
// camera compositor (CameraCompositor). Given a Rough.js canvas (for geometric
// shapes) and a raw 2D context (for freehand + live stroke + cursor + HUD).
import type { RoughCanvas } from 'roughjs/bin/canvas';
import type { Point, Shape } from './types';
import type { Gesture } from './gestures';

export function drawShape(rc: RoughCanvas, ctx: CanvasRenderingContext2D, s: Shape) {
  const opts = { stroke: (s as any).color, strokeWidth: 3, roughness: 1.1, bowing: 1 };
  switch (s.kind) {
    case 'free':
      // freehand is a real pen line, not a sketchy Rough path -> smooth + solid
      drawSmoothStroke(ctx, s.pts, s.color, s.w);
      break;
    case 'rect':
      rc.rectangle(s.x, s.y, s.w, s.h, opts);
      break;
    case 'circle':
      rc.circle(s.cx, s.cy, s.r * 2, opts);
      break;
    case 'line':
      rc.line(s.from.x, s.from.y, s.to.x, s.to.y, opts);
      break;
    case 'arrow':
      drawArrow(rc, s.from, s.to, s.color);
      break;
    case 'text': {
      ctx.save();
      ctx.fillStyle = s.color;
      ctx.textBaseline = 'top';
      ctx.font = `600 ${s.h}px system-ui, -apple-system, sans-serif`;
      if (s.mirror) {
        // camera mode: mirror the glyph so it reads correctly in the (mirrored)
        // self-view, matching how freehand ink already looks to the drawer.
        ctx.translate(s.x + textWidth(s), 0);
        ctx.scale(-1, 1);
        ctx.fillText(s.text, 0, s.y);
      } else {
        ctx.fillText(s.text, s.x, s.y);
      }
      ctx.restore();
      break;
    }
  }
}

// approx rendered width of a text shape (for hit-testing / bbox)
export function textWidth(s: { text: string; h: number }): number {
  return Math.max(s.h * 0.62, s.text.length * s.h * 0.62);
}

export function drawArrow(rc: RoughCanvas, from: Point, to: Point, color: string) {
  rc.line(from.x, from.y, to.x, to.y, { stroke: color, strokeWidth: 3, roughness: 1 });
  const ang = Math.atan2(to.y - from.y, to.x - from.x);
  const head = 16;
  for (const s of [-1, 1]) {
    const a = ang + s * 0.4 + Math.PI;
    rc.line(to.x, to.y, to.x + head * Math.cos(a), to.y + head * Math.sin(a), {
      stroke: color,
      strokeWidth: 3,
      roughness: 1,
    });
  }
}

// Smooth, solid pen stroke. Draws quadratic curves through the midpoints of
// consecutive samples, which turns a sparse/angular polyline into a continuous
// smooth line — the fix for "gaps between lines" on fast strokes.
export function drawSmoothStroke(
  ctx: CanvasRenderingContext2D,
  pts: Point[],
  color: string,
  w: number,
) {
  if (pts.length === 0) return;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = w;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  if (pts.length === 1) {
    ctx.beginPath();
    ctx.arc(pts[0].x, pts[0].y, w / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length - 1; i++) {
    const midX = (pts[i].x + pts[i + 1].x) / 2;
    const midY = (pts[i].y + pts[i + 1].y) / 2;
    ctx.quadraticCurveTo(pts[i].x, pts[i].y, midX, midY);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo(last.x, last.y);
  ctx.stroke();
}

export function drawCursor(ctx: CanvasRenderingContext2D, cursor: Point, drawing: boolean, color: string) {
  ctx.beginPath();
  ctx.arc(cursor.x, cursor.y, drawing ? 8 : 12, 0, Math.PI * 2);
  ctx.strokeStyle = drawing ? color : 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 2;
  ctx.stroke();
  if (drawing) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(cursor.x, cursor.y, 3, 0, Math.PI * 2);
    ctx.fill();
  }
}

export function drawEraser(ctx: CanvasRenderingContext2D, p: Point, r: number) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.setLineDash([5, 4]);
  ctx.stroke();
  ctx.restore();
}

export function drawSelection(
  ctx: CanvasRenderingContext2D,
  box: { x: number; y: number; w: number; h: number },
) {
  const pad = 8;
  ctx.save();
  ctx.strokeStyle = '#0a84ff';
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  ctx.strokeRect(box.x - pad, box.y - pad, box.w + pad * 2, box.h + pad * 2);
  ctx.restore();
}

export function drawLandmarks(ctx: CanvasRenderingContext2D, pts: Point[]) {
  ctx.fillStyle = 'rgba(0,220,255,0.85)';
  for (const p of pts) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
    ctx.fill();
  }
}

export function drawHUD(ctx: CanvasRenderingContext2D, gesture: Gesture, fps: number, mode: string) {
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(12, 12, 190, 62);
  ctx.fillStyle = '#fff';
  ctx.font = '13px ui-monospace, monospace';
  ctx.fillText(`gesture: ${gesture}`, 22, 32);
  ctx.fillText(`fps: ${fps.toFixed(0)}`, 22, 50);
  ctx.fillText(`mode: ${mode}`, 22, 68);
}
