// Camera-overlay mode. Wraps the real webcam stream Meet requested: plays it into
// a hidden <video>, paints "video + drawing" onto a canvas every frame, and hands
// canvas.captureStream() (plus the untouched audio track) back to Meet. Result:
// the drawing appears on your webcam tile for everyone, no screen-share needed.
import rough from 'roughjs';
import type { RoughCanvas } from 'roughjs/bin/canvas';
import type { RenderState, Shape } from './types';
import { drawShape, drawSmoothStroke, drawCursor, drawEraser, drawSelection } from './draw';

export class CameraCompositor {
  readonly video: HTMLVideoElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  // committed shapes live on a separate ink layer that's only repainted when the
  // shape list changes — so they don't shimmer/re-randomize every frame.
  private ink: HTMLCanvasElement;
  private inkCtx: CanvasRenderingContext2D;
  private inkRc: RoughCanvas;
  private out: MediaStream | null = null;
  private rafId = 0;
  active = false;
  width = 640;
  height = 480;

  constructor(
    private source: MediaStream,
    private getState: () => RenderState,
  ) {
    this.video = document.createElement('video');
    this.video.autoplay = true;
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.srcObject = new MediaStream(this.source.getVideoTracks());
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d')!;
    this.ink = document.createElement('canvas');
    this.inkCtx = this.ink.getContext('2d')!;
    this.inkRc = rough.canvas(this.ink);
    // IMPORTANT: some browsers won't decode/play a detached <video> or capture a
    // detached <canvas> reliably, so the visible ones must be in the DOM (hidden).
    const hide = { position: 'fixed', left: '0', top: '0', width: '1px', height: '1px', opacity: '0', pointerEvents: 'none', zIndex: '-1' } as CSSStyleDeclaration;
    Object.assign(this.video.style, hide);
    Object.assign(this.canvas.style, hide);
    document.documentElement.append(this.video, this.canvas);
  }

  async start(): Promise<MediaStream> {
    await this.video.play().catch((e) => console.warn('[GestureDraw] compositor video.play()', e));
    if (this.video.readyState < 2) {
      await Promise.race([
        new Promise<void>((res) => (this.video.onloadeddata = () => res())),
        new Promise<void>((res) => setTimeout(res, 2500)),
      ]);
    }
    this.width = this.video.videoWidth || 640;
    this.height = this.video.videoHeight || 480;
    for (const c of [this.canvas, this.ink]) {
      c.width = this.width;
      c.height = this.height;
    }
    this.inkRc = rough.canvas(this.ink);

    const captured = this.canvas.captureStream(30);
    this.out = new MediaStream([...captured.getVideoTracks(), ...this.source.getAudioTracks()]);
    this.active = true;
    this.loop();
    console.log(`[GestureDraw] compositor started ${this.width}x${this.height}, feeding Meet a canvas stream`);
    return this.out;
  }

  // repaint the committed ink layer — call only when the shape list changes.
  renderInk(shapes: Shape[]) {
    this.inkCtx.clearRect(0, 0, this.width, this.height);
    for (const s of shapes) drawShape(this.inkRc, this.inkCtx, s);
  }

  private loop = () => {
    this.rafId = requestAnimationFrame(this.loop);
    const ctx = this.ctx;
    if (this.video.readyState >= 2) {
      ctx.drawImage(this.video, 0, 0, this.width, this.height);
    } else {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, this.width, this.height);
    }
    ctx.drawImage(this.ink, 0, 0);
    const s = this.getState();
    if (s.selection) drawSelection(ctx, s.selection);
    for (const bs of s.bufferStrokes) drawSmoothStroke(ctx, bs, s.color, s.strokeWidth);
    if (s.activeStroke) drawSmoothStroke(ctx, s.activeStroke, s.color, s.strokeWidth);
    if (s.eraseCursor) drawEraser(ctx, s.eraseCursor, s.eraseRadius);
    if (s.cursor) drawCursor(ctx, s.cursor, !!s.activeStroke, s.color);
  };

  get outputStream(): MediaStream | null {
    return this.out;
  }

  stop() {
    this.active = false;
    cancelAnimationFrame(this.rafId);
    this.out?.getVideoTracks().forEach((t) => t.stop());
    this.video.srcObject = null;
    this.video.remove();
    this.canvas.remove();
    this.out = null;
  }
}
