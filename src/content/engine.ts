// MAIN-world engine: camera -> hand tracking -> gesture -> draw -> overlay.
// Runs in the page's main world so MediaPipe's WASM loader (which appends a
// <script> that runs in the main world) correctly sets ModuleFactory, and so we
// can intercept getUserMedia for camera-overlay mode. It has NO access to
// chrome.* APIs — the isolated "bridge" content script feeds it settings/actions
// via DOM CustomEvents and the extension base URL via a data-attribute.
import { CameraManager } from './CameraManager';
import { CameraCompositor } from './CameraCompositor';
import { HandTracker } from './HandTracker';
import { GestureRecognizer, type Gesture, type LM } from './gestures';
import { OneEuro2D, smoothingToParams } from './OneEuroFilter';
import { Renderer } from './Renderer';
import { snapStroke } from './shapeSnap';
import { shapeHit, pickShape, shapeBBox, translateShape } from './hitTest';
import { recognizeChar } from './recognize';
import { DEFAULT_SETTINGS, type DrawMode, type Handed, type Point, type RenderState, type Settings, type Shape } from './types';

const EV_READY = 'gd:engine-ready';
const EV_CMD = 'gd:cmd';
const EV_STATUS = 'gd:status';

type Cmd =
  | { kind: 'settings'; settings: Partial<Settings> }
  | { kind: 'clear' }
  | { kind: 'undo' };

// shared with the getUserMedia patch, which is installed at document_start
// before the Engine (and Meet) exist.
const controller: {
  enabled: boolean;
  mode: DrawMode;
  makeComposite: ((s: MediaStream) => Promise<MediaStream>) | null;
} = { enabled: false, mode: DEFAULT_SETTINGS.mode, makeComposite: null };

// Intercept Meet's camera request. In camera mode we return a canvas stream that
// composites "webcam + drawing"; otherwise we pass the real stream through.
function patchGetUserMedia() {
  const md = navigator.mediaDevices as MediaDevices & {
    __gdPatched?: boolean;
    __gdRealGUM?: (c?: MediaStreamConstraints) => Promise<MediaStream>;
  };
  if (!md || md.__gdPatched) return;
  const real = md.getUserMedia.bind(md);
  md.__gdRealGUM = real;
  md.__gdPatched = true;
  md.getUserMedia = async (constraints?: MediaStreamConstraints) => {
    const stream = await real(constraints);
    const wantsVideo = !!constraints?.video;
    console.log(
      `[GestureDraw] getUserMedia(video=${wantsVideo}) — enabled=${controller.enabled} mode=${controller.mode} ready=${!!controller.makeComposite}`,
    );
    try {
      if (wantsVideo && controller.enabled && controller.mode === 'camera' && controller.makeComposite) {
        console.log('[GestureDraw] → intercepting: returning composited camera stream');
        return await controller.makeComposite(stream);
      }
      if (wantsVideo && controller.mode === 'camera' && controller.enabled) {
        console.warn('[GestureDraw] → camera mode on but engine not ready yet; passing raw camera');
      }
    } catch (e) {
      console.error('[GestureDraw] composite failed, passing raw camera', e);
    }
    return stream;
  };
  console.log('[GestureDraw] getUserMedia patched at', document.readyState);
}

// Google Meet enforces Trusted Types; MediaPipe's WASM loader assigns a raw
// string to <script>.src, which is blocked. A pass-through default policy
// sanitizes raw-string sink assignments (only ones Meet's own compliant code
// never makes, so it doesn't change Meet's behavior).
function installTrustedTypesPolicy() {
  const tt = (window as any).trustedTypes;
  if (!tt || typeof tt.createPolicy !== 'function') return;
  if ((window as any).__gdTTInstalled) return;
  if (tt.defaultPolicy) {
    (window as any).__gdTTInstalled = true;
    return;
  }
  try {
    tt.createPolicy('default', {
      createScriptURL: (s: string) => s,
      createScript: (s: string) => s,
      createHTML: (s: string) => s,
    });
    (window as any).__gdTTInstalled = true;
  } catch (e) {
    throw new Error(`Trusted Types blocked our policy — Meet forbids it. (${(e as Error).message})`);
  }
}

class Engine {
  private settings: Settings = { ...DEFAULT_SETTINGS };
  private camera = new CameraManager();
  private tracker = new HandTracker();
  // one recognizer per hand so pinch hysteresis is tracked independently
  private recognizers = new Map<Handed, GestureRecognizer>();
  // 1€ filter driven by the "Smoothing" slider (see smoothingToParams).
  private cursorFilter = new OneEuro2D();
  private container!: HTMLElement;
  private renderer!: Renderer;
  private compositor: CameraCompositor | null = null;
  private banner!: HTMLElement;

  private shapes: Shape[] = [];
  private activeStroke: Point[] | null = null;
  private cursor: Point | null = null;
  private eraseCursor: Point | null = null;
  private eraseRadius = 24;
  private selectedIdx = -1; // shape being grabbed by pinch, or -1
  private grabPrev: Point | null = null;
  private gesture: Gesture = 'idle';
  private running = false;
  private rafId = 0;
  private lastError: string | undefined;

  private frameCount = 0;
  private fps = 0;
  private lastFpsT = performance.now();

  private base(): string {
    return document.documentElement.dataset.gdBase ?? '';
  }

  private recognizerFor(h: Handed): GestureRecognizer {
    let r = this.recognizers.get(h);
    if (!r) {
      r = new GestureRecognizer(this.settings.pinchThreshold);
      this.recognizers.set(h, r);
    }
    return r;
  }

  init() {
    this.container = document.createElement('div');
    this.container.id = 'gesture-draw-root';
    document.documentElement.appendChild(this.container);
    this.renderer = new Renderer(this.container);

    this.banner = document.createElement('div');
    Object.assign(this.banner.style, {
      position: 'fixed',
      top: '76px',
      left: '50%',
      transform: 'translateX(-50%)',
      background: '#ff375f',
      color: '#fff',
      font: '600 13px/1.4 -apple-system, system-ui, sans-serif',
      padding: '8px 14px',
      borderRadius: '10px',
      zIndex: '2147483647',
      pointerEvents: 'none',
      boxShadow: '0 4px 16px rgba(0,0,0,.35)',
      display: 'none',
      maxWidth: '360px',
      textAlign: 'center',
    } as CSSStyleDeclaration);
    this.container.appendChild(this.banner);

    controller.makeComposite = (s) => this.makeComposite(s);

    window.addEventListener(EV_CMD, (e) => this.onCmd((e as CustomEvent<Cmd>).detail));
    this.wireKeyboard();
    window.dispatchEvent(new CustomEvent(EV_READY));
    this.emitStatus();
  }

  // called by the getUserMedia patch when Meet requests the camera in camera mode
  private async makeComposite(source: MediaStream): Promise<MediaStream> {
    this.compositor?.stop();
    const comp = new CameraCompositor(source, () => this.renderState());
    const out = await comp.start();
    this.compositor = comp;
    comp.renderInk(this.shapes); // paint any existing shapes onto the ink layer
    // when Meet stops the camera, tear the compositor down
    source.getVideoTracks()[0]?.addEventListener('ended', () => {
      if (this.compositor === comp) {
        comp.stop();
        this.compositor = null;
      }
    });
    return out;
  }

  // live overlay the compositor paints each frame — empty unless actively drawing
  private renderState(): RenderState {
    const active = this.running && this.settings.mode === 'camera';
    return {
      activeStroke: active ? this.activeStroke : null,
      color: this.settings.color,
      strokeWidth: this.settings.strokeWidth,
      cursor: active ? this.cursor : null,
      eraseCursor: active ? this.eraseCursor : null,
      eraseRadius: this.eraseRadius,
      selection: active ? this.selectionBox() : null,
      gesture: this.gesture,
    };
  }

  private selectionBox() {
    return this.selectedIdx >= 0 && this.shapes[this.selectedIdx]
      ? shapeBBox(this.shapes[this.selectedIdx])
      : null;
  }

  // repaint committed ink on whichever surface is active for the current mode.
  private renderCommitted() {
    if (this.settings.mode === 'camera') this.compositor?.renderInk(this.shapes);
    else this.renderer.renderStatic(this.shapes);
  }

  // the video feeding hand tracking. In camera mode we track from the SAME
  // stream we composite (Meet's), so landmarks line up exactly with the drawn
  // frame — no aspect-ratio mismatch between two camera opens.
  private trackingVideo(): HTMLVideoElement | null {
    if (this.settings.mode === 'camera') {
      return this.compositor && this.compositor.active ? this.compositor.video : null;
    }
    return this.camera.ready ? this.camera.video : null;
  }

  private emitStatus() {
    window.dispatchEvent(
      new CustomEvent(EV_STATUS, {
        detail: { running: this.running, error: this.lastError, mode: this.settings.mode },
      }),
    );
  }

  private onCmd(cmd: Cmd) {
    if (cmd.kind === 'settings') this.applySettings(cmd.settings);
    else if (cmd.kind === 'clear') this.clearAll();
    else if (cmd.kind === 'undo') this.undo();
  }

  private wireKeyboard() {
    window.addEventListener('keydown', (e) => {
      if (!this.settings.enabled) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'c' || e.key === 'C') this.clearAll();
      if ((e.key === 'z' || e.key === 'Z') && !e.metaKey && !e.ctrlKey) this.undo();
    });
  }

  private async applySettings(patch: Partial<Settings>) {
    const prev = this.settings;
    this.settings = { ...this.settings, ...patch };
    controller.mode = this.settings.mode;
    console.log('[GestureDraw] settings applied:', {
      enabled: this.settings.enabled,
      mode: this.settings.mode,
      color: this.settings.color,
      shapeMode: this.settings.shapeMode,
    });
    if (patch.pinchThreshold !== undefined)
      this.recognizers.forEach((r) => r.setThreshold(patch.pinchThreshold!));
    if (patch.smoothing !== undefined) {
      const p = smoothingToParams(patch.smoothing);
      this.cursorFilter.setParams(p.minCutoff, p.beta);
    }

    const modeChanged = patch.mode !== undefined && patch.mode !== prev.mode;
    if (patch.enabled !== undefined && patch.enabled !== prev.enabled) {
      if (patch.enabled) await this.start();
      else this.stop();
    } else if (modeChanged && this.running) {
      // switching mode: coordinate spaces differ, so reset the canvas, and the
      // new mode may need our own tracking camera (screen) or not (camera).
      this.clearAll();
      this.renderer.clearLive();
      if (this.settings.mode === 'screen' && !this.camera.ready) {
        this.camera.start().catch((e) => console.warn('[GestureDraw] camera start', e));
      }
    }
    this.emitStatus();
  }

  // scripts run at document_start (so the getUserMedia patch beats Meet), but
  // MediaPipe's loader needs <body> to appendChild its script — wait for it.
  private whenDomReady(): Promise<void> {
    if (document.body) return Promise.resolve();
    return new Promise((res) => {
      const obs = new MutationObserver(() => {
        if (document.body) {
          obs.disconnect();
          res();
        }
      });
      obs.observe(document.documentElement, { childList: true, subtree: true });
    });
  }

  private async start() {
    if (this.running) return;
    this.lastError = undefined;
    controller.enabled = true;
    controller.mode = this.settings.mode;
    this.emitStatus();
    try {
      await this.whenDomReady();
      installTrustedTypesPolicy();
      await this.tracker.init(this.base() + 'wasm', this.base() + 'models/hand_landmarker.task');
      // screen mode tracks from our own camera; camera mode tracks from the
      // composited Meet stream, so we don't open a second camera there.
      if (this.settings.mode === 'screen') await this.camera.start();
      this.running = true;
      this.loop();
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.running = false;
      controller.enabled = false;
      console.error('[GestureDraw] start failed:', err);
    }
    this.emitStatus();
  }

  private stop() {
    this.running = false;
    controller.enabled = false;
    cancelAnimationFrame(this.rafId);
    this.camera.stop();
    this.tracker.close();
    this.activeStroke = null;
    this.cursor = null;
    this.renderer.clearLive();
    this.banner.style.display = 'none';
    // NB: leave the compositor running as a plain passthrough so Meet's video
    // doesn't freeze; it tears down when Meet stops the camera.
    this.emitStatus();
  }

  private clearAll() {
    this.shapes = [];
    this.renderCommitted();
  }

  private undo() {
    this.shapes.pop();
    this.renderCommitted();
  }

  // target dimensions + whether to mirror, per mode. null if camera mode has no
  // compositor yet (Meet hasn't requested the camera through our patch).
  private targetDims(): { w: number; h: number; mirror: boolean } | null {
    if (this.settings.mode === 'camera') {
      if (!this.compositor) return null;
      return { w: this.compositor.width, h: this.compositor.height, mirror: false };
    }
    return { w: window.innerWidth, h: window.innerHeight, mirror: true };
  }

  private toTarget(lm: LM, dims: { w: number; h: number; mirror: boolean }): Point {
    const nx = dims.mirror ? 1 - lm.x : lm.x;
    return { x: nx * dims.w, y: lm.y * dims.h };
  }

  private loop = () => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.loop);
    const now = performance.now();
    this.tickFps(now);

    const camMode = this.settings.mode === 'camera';
    const dims = this.targetDims();

    let debugPts: Point[] | undefined;
    let handInfo = 'no hands';
    const video = this.trackingVideo();
    if (video && dims) {
      const hands = this.tracker.detect(video, now);
      if (hands) {
        this.eraseRadius = Math.max(18, dims.w * 0.05);
        const drawHand = hands.find((h) => h.handedness === this.settings.drawHand);
        const eraseHand = hands.find((h) => h.handedness !== this.settings.drawHand);
        handInfo = hands.map((h) => h.handedness[0]).join('+') || 'no hands';

        // DRAW HAND: pointing (only index up) = pen down, else lift & commit
        if (drawHand) {
          const r = this.recognizerFor(drawHand.handedness).read(drawHand.landmarks);
          this.gesture = r.gesture;
          const raw = this.toTarget(r.indexTip, dims);
          this.cursor = this.cursorFilter.filter(raw.x, raw.y, now);
          if (r.gesture === 'point') {
            this.endGrab();
            this.drawPoint(this.cursor);
          } else if (r.gesture === 'pinch') {
            this.liftPen();
            this.grabMove(this.cursor);
          } else {
            this.liftPen();
            this.endGrab();
          }
          if (this.settings.showDebug && !camMode) {
            debugPts = drawHand.landmarks.map((l) => this.toTarget(l, dims));
          }
        } else {
          this.liftPen();
          this.endGrab();
          this.cursor = null;
          this.gesture = 'idle';
        }

        // ERASE HAND: pointing = erase ink under the fingertip
        const eraseReading = eraseHand && this.recognizerFor(eraseHand.handedness).read(eraseHand.landmarks);
        if (eraseHand && eraseReading && eraseReading.gesture === 'point') {
          this.eraseCursor = this.toTarget(eraseHand.landmarks[8], dims);
          this.eraseAt(this.eraseCursor);
        } else {
          this.eraseCursor = null;
        }
      }
    } else {
      this.liftPen();
    }

    // camera mode with no compositor yet -> Meet hasn't routed the camera
    // through our patch; prompt the user to toggle it.
    const waitingForCam = camMode && !this.compositor;
    this.banner.style.display = waitingForCam ? 'block' : 'none';
    if (waitingForCam) {
      this.banner.textContent = '✍️ Camera mode: toggle your Meet camera OFF then ON to start drawing on it';
    }

    const hudMode = camMode
      ? this.compositor
        ? `camera ✓ ${this.compositor.width}x${this.compositor.height} · hands:${handInfo}`
        : 'camera (toggle Meet cam)'
      : `screen · hands:${handInfo}`;

    // screen mode paints everything on the overlay; camera mode paints the
    // drawing on the compositor and keeps only the HUD on screen.
    this.renderer.renderLive({
      stroke: camMode ? null : this.activeStroke,
      color: this.settings.color,
      strokeWidth: this.settings.strokeWidth,
      cursor: camMode ? null : this.cursor,
      eraseCursor: camMode ? null : this.eraseCursor,
      eraseRadius: this.eraseRadius,
      selection: camMode ? null : this.selectionBox(),
      gesture: this.gesture,
      landmarks: debugPts,
      showDebug: this.settings.showDebug,
      fps: this.fps,
      mode: hudMode,
    });
  };

  private drawPoint(cursor: Point) {
    if (!this.activeStroke) this.activeStroke = [];
    const last = this.activeStroke[this.activeStroke.length - 1];
    if (!last || Math.hypot(cursor.x - last.x, cursor.y - last.y) > 2) {
      this.activeStroke.push(cursor);
    }
  }

  private liftPen() {
    if (this.activeStroke) this.commitStroke();
  }

  private eraseAt(p: Point) {
    const before = this.shapes.length;
    this.shapes = this.shapes.filter((s) => !shapeHit(s, p, this.eraseRadius));
    if (this.shapes.length !== before) {
      this.endGrab();
      this.renderCommitted();
    }
  }

  // pinch: grab the nearest shape, then drag it to follow the fingertip.
  private grabMove(cursor: Point) {
    if (this.selectedIdx < 0) {
      const idx = pickShape(this.shapes, cursor, this.eraseRadius * 1.6);
      if (idx >= 0) {
        this.selectedIdx = idx;
        this.grabPrev = { ...cursor };
      }
    } else if (this.grabPrev) {
      const dx = cursor.x - this.grabPrev.x;
      const dy = cursor.y - this.grabPrev.y;
      if (dx || dy) {
        translateShape(this.shapes[this.selectedIdx], dx, dy);
        this.grabPrev = { ...cursor };
        this.renderCommitted();
      }
    }
  }

  private endGrab() {
    this.selectedIdx = -1;
    this.grabPrev = null;
  }

  private commitStroke() {
    const stroke = this.activeStroke;
    this.activeStroke = null;
    if (!stroke || stroke.length < 3) return;

    // Text mode: recognize the stroke as a letter/number and replace it with
    // clean typed text. Unrecognized strokes fall back to freehand.
    if (this.settings.shapeMode === 'text') {
      const rec = recognizeChar(stroke);
      if (rec) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of stroke) {
          minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
          maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
        }
        const h = Math.max(maxY - minY, 28);
        this.shapes.push({ kind: 'text', x: minX, y: minY, h, text: rec.char, color: this.settings.color });
        this.renderCommitted();
        return;
      }
    }

    const mode = this.settings.shapeMode === 'text' ? 'free' : this.settings.shapeMode;
    const shape = snapStroke(stroke, mode, this.settings.color, this.settings.strokeWidth);
    this.shapes.push(shape);
    this.renderCommitted();
  }

  private tickFps(now: number) {
    this.frameCount++;
    if (now - this.lastFpsT >= 500) {
      this.fps = (this.frameCount * 1000) / (now - this.lastFpsT);
      this.frameCount = 0;
      this.lastFpsT = now;
    }
  }
}

// install the getUserMedia patch as early as possible (document_start)
patchGetUserMedia();

if (!(window as any).__gestureDrawEngine) {
  (window as any).__gestureDrawEngine = true;
  const start = () => new Engine().init();
  if (document.documentElement.dataset.gdBase) start();
  else {
    const obs = new MutationObserver(() => {
      if (document.documentElement.dataset.gdBase) {
        obs.disconnect();
        start();
      }
    });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-gd-base'] });
  }
}
