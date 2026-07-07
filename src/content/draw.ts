// Shared drawing primitives, used by both the screen overlay (Renderer) and the
// camera compositor (CameraCompositor). Given a Rough.js canvas (for committed
// shapes) and a raw 2D context (for the live stroke / cursor / HUD).
import type { RoughCanvas } from 'roughjs/bin/canvas';
import type { Point, Shape } from './types';
import type { Gesture } from './gestures';

export function drawShape(rc: RoughCanvas, s: Shape) {
  const color = (s as any).color as string;
  const opts = { stroke: color, strokeWidth: 3, roughness: 1.1, bowing: 1 };
  switch (s.kind) {
    case 'free':
      if (s.pts.length < 2) return;
      rc.linearPath(s.pts.map((p) => [p.x, p.y]) as [number, number][], {
        stroke: s.color,
        strokeWidth: s.w,
        roughness: 0.8,
      });
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
  }
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

export function drawLiveStroke(ctx: CanvasRenderingContext2D, pts: Point[], color: string, w: number) {
  if (pts.length < 2) return;
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = w;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.moveTo(pts[0].x, pts[0].y);
  for (const p of pts) ctx.lineTo(p.x, p.y);
  ctx.stroke();
}

export function drawCursor(ctx: CanvasRenderingContext2D, cursor: Point, drawing: boolean, color: string) {
  ctx.beginPath();
  ctx.arc(cursor.x, cursor.y, drawing ? 9 : 13, 0, Math.PI * 2);
  ctx.strokeStyle = drawing ? color : 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 2;
  ctx.stroke();
  if (drawing) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(cursor.x, cursor.y, 4, 0, Math.PI * 2);
    ctx.fill();
  }
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
