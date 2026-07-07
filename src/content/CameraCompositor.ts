// Camera-overlay mode. Wraps the real webcam stream Meet requested: plays it into
// a hidden <video>, paints "video + drawing" onto a canvas every frame, and hands
// canvas.captureStream() (plus the untouched audio track) back to Meet. Result:
// the drawing appears on your webcam tile for everyone, no screen-share needed.
// The same <video> element is also the source for hand tracking.
import rough from 'roughjs';
import type { RoughCanvas } from 'roughjs/bin/canvas';
import type { RenderState } from './types';
import { drawShape, drawLiveStroke, drawCursor } from './draw';

export class CameraCompositor {
  readonly video: HTMLVideoElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private rc: RoughCanvas;
  private out: MediaStream | null = null;
  private rafId = 0;
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
    this.rc = rough.canvas(this.canvas);
  }

  async start(): Promise<MediaStream> {
    await this.video.play().catch(() => {});
    if (this.video.readyState < 2) {
      await new Promise<void>((res) => (this.video.onloadeddata = () => res()));
    }
    this.width = this.video.videoWidth || 640;
    this.height = this.video.videoHeight || 480;
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.rc = rough.canvas(this.canvas);

    const captured = this.canvas.captureStream(30);
    // keep Meet's audio untouched; only the video is our composited canvas
    this.out = new MediaStream([...captured.getVideoTracks(), ...this.source.getAudioTracks()]);
    this.loop();
    return this.out;
  }

  private loop = () => {
    this.rafId = requestAnimationFrame(this.loop);
    const ctx = this.ctx;
    if (this.video.readyState >= 2) {
      ctx.drawImage(this.video, 0, 0, this.width, this.height);
    }
    const s = this.getState();
    for (const shape of s.shapes) drawShape(this.rc, shape);
    if (s.activeStroke) drawLiveStroke(ctx, s.activeStroke, s.color, s.strokeWidth);
    if (s.cursor) drawCursor(ctx, s.cursor, s.gesture === 'pinch', s.color);
  };

  get outputStream(): MediaStream | null {
    return this.out;
  }

  stop() {
    cancelAnimationFrame(this.rafId);
    this.out?.getVideoTracks().forEach((t) => t.stop());
    this.video.srcObject = null;
    this.out = null;
  }
}
