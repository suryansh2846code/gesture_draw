// Draws committed shapes + the live stroke/cursor onto a transparent overlay.
// Two canvases: a static layer (committed, repainted only on change) and a live
// layer (repainted every frame). Uses Rough.js for a forgiving hand-drawn look.
import rough from 'roughjs';
import type { RoughCanvas } from 'roughjs/bin/canvas';
import type { Point, Shape } from './types';
import type { Gesture } from './gestures';

export class Renderer {
  private staticCanvas: HTMLCanvasElement;
  private liveCanvas: HTMLCanvasElement;
  private sctx: CanvasRenderingContext2D;
  private lctx: CanvasRenderingContext2D;
  private rc: RoughCanvas;
  private dpr = Math.min(window.devicePixelRatio || 1, 2);

  constructor(container: HTMLElement) {
    this.staticCanvas = this.makeCanvas(1);
    this.liveCanvas = this.makeCanvas(2);
    container.append(this.staticCanvas, this.liveCanvas);
    this.sctx = this.staticCanvas.getContext('2d')!;
    this.lctx = this.liveCanvas.getContext('2d')!;
    this.rc = rough.canvas(this.staticCanvas);
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  private makeCanvas(z: number): HTMLCanvasElement {
    const c = document.createElement('canvas');
    Object.assign(c.style, {
      position: 'fixed',
      inset: '0',
      width: '100vw',
      height: '100vh',
      pointerEvents: 'none',
      zIndex: String(2147483600 + z),
    } as CSSStyleDeclaration);
    return c;
  }

  resize() {
    for (const c of [this.staticCanvas, this.liveCanvas]) {
      c.width = Math.floor(window.innerWidth * this.dpr);
      c.height = Math.floor(window.innerHeight * this.dpr);
    }
    this.sctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.lctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.rc = rough.canvas(this.staticCanvas);
  }

  // repaint the committed layer (call only when the shape list changes)
  renderStatic(shapes: Shape[]) {
    this.sctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    for (const s of shapes) this.drawShape(s);
  }

  private drawShape(s: Shape) {
    const opts = { stroke: (s as any).color, strokeWidth: 3, roughness: 1.1, bowing: 1 };
    switch (s.kind) {
      case 'free': {
        if (s.pts.length < 2) return;
        this.rc.linearPath(s.pts.map((p) => [p.x, p.y]) as [number, number][], {
          stroke: s.color,
          strokeWidth: s.w,
          roughness: 0.8,
        });
        break;
      }
      case 'rect':
        this.rc.rectangle(s.x, s.y, s.w, s.h, opts);
        break;
      case 'circle':
        this.rc.circle(s.cx, s.cy, s.r * 2, opts);
        break;
      case 'line':
        this.rc.line(s.from.x, s.from.y, s.to.x, s.to.y, opts);
        break;
      case 'arrow':
        this.drawArrow(s.from, s.to, s.color);
        break;
    }
  }

  private drawArrow(from: Point, to: Point, color: string) {
    this.rc.line(from.x, from.y, to.x, to.y, { stroke: color, strokeWidth: 3, roughness: 1 });
    const ang = Math.atan2(to.y - from.y, to.x - from.x);
    const head = 16;
    for (const s of [-1, 1]) {
      const a = ang + s * 0.4 + Math.PI;
      this.rc.line(to.x, to.y, to.x + head * Math.cos(a), to.y + head * Math.sin(a), {
        stroke: color,
        strokeWidth: 3,
        roughness: 1,
      });
    }
  }

  // live layer: current in-progress stroke + cursor + optional debug HUD
  renderLive(opts: {
    stroke: Point[] | null;
    color: string;
    strokeWidth: number;
    cursor: Point | null;
    gesture: Gesture;
    landmarks?: Point[];
    showDebug: boolean;
    fps: number;
  }) {
    const ctx = this.lctx;
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

    if (opts.stroke && opts.stroke.length > 1) {
      ctx.beginPath();
      ctx.strokeStyle = opts.color;
      ctx.lineWidth = opts.strokeWidth;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.moveTo(opts.stroke[0].x, opts.stroke[0].y);
      for (const p of opts.stroke) ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }

    if (opts.showDebug && opts.landmarks) {
      ctx.fillStyle = 'rgba(0,220,255,0.85)';
      for (const p of opts.landmarks) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (opts.cursor) {
      const drawing = opts.gesture === 'pinch';
      ctx.beginPath();
      ctx.arc(opts.cursor.x, opts.cursor.y, drawing ? 9 : 13, 0, Math.PI * 2);
      ctx.strokeStyle = drawing ? opts.color : 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 2;
      ctx.stroke();
      if (drawing) {
        ctx.fillStyle = opts.color;
        ctx.beginPath();
        ctx.arc(opts.cursor.x, opts.cursor.y, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (opts.showDebug) {
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(12, 12, 168, 46);
      ctx.fillStyle = '#fff';
      ctx.font = '13px ui-monospace, monospace';
      ctx.fillText(`gesture: ${opts.gesture}`, 22, 32);
      ctx.fillText(`fps: ${opts.fps.toFixed(0)}`, 22, 50);
    }
  }

  clearLive() {
    this.lctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  }

  destroy() {
    this.staticCanvas.remove();
    this.liveCanvas.remove();
  }
}
