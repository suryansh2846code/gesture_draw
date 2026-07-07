// Screen overlay for "screen" mode (and the local debug HUD in both modes).
// Two fixed, click-through canvases: a static layer for committed shapes
// (repainted only on change) and a live layer repainted every frame.
import rough from 'roughjs';
import type { RoughCanvas } from 'roughjs/bin/canvas';
import type { Point, Shape } from './types';
import type { Gesture } from './gestures';
import { drawShape, drawLiveStroke, drawCursor, drawLandmarks, drawHUD } from './draw';

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

  renderStatic(shapes: Shape[]) {
    this.sctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    for (const s of shapes) drawShape(this.rc, s);
  }

  renderLive(opts: {
    stroke: Point[] | null;
    color: string;
    strokeWidth: number;
    cursor: Point | null;
    gesture: Gesture;
    landmarks?: Point[];
    showDebug: boolean;
    fps: number;
    mode: string;
  }) {
    const ctx = this.lctx;
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    if (opts.stroke) drawLiveStroke(ctx, opts.stroke, opts.color, opts.strokeWidth);
    if (opts.showDebug && opts.landmarks) drawLandmarks(ctx, opts.landmarks);
    if (opts.cursor) drawCursor(ctx, opts.cursor, opts.gesture === 'pinch', opts.color);
    if (opts.showDebug) drawHUD(ctx, opts.gesture, opts.fps, opts.mode);
  }

  clearStatic() {
    this.sctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  }

  clearLive() {
    this.lctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  }

  destroy() {
    this.staticCanvas.remove();
    this.liveCanvas.remove();
  }
}
