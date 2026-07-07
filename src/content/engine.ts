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
import { OneEuro2D } from './OneEuroFilter';
import { Renderer } from './Renderer';
import { snapStroke } from './shapeSnap';
import { DEFAULT_SETTINGS, type DrawMode, type Point, type RenderState, type Settings, type Shape } from './types';

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
    try {
      if (constraints?.video && controller.enabled && controller.mode === 'camera' && controller.makeComposite) {
        return await controller.makeComposite(stream);
      }
    } catch (e) {
      console.error('[GestureDraw] composite failed, passing raw camera', e);
    }
    return stream;
  };
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
  private recognizer = new GestureRecognizer(DEFAULT_SETTINGS.pinchThreshold);
  private cursorFilter = new OneEuro2D(1.2, 0.02);
  private container!: HTMLElement;
  private renderer!: Renderer;
  private compositor: CameraCompositor | null = null;

  private shapes: Shape[] = [];
  private activeStroke: Point[] | null = null;
  private cursor: Point | null = null;
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

  init() {
    this.container = document.createElement('div');
    this.container.id = 'gesture-draw-root';
    document.documentElement.appendChild(this.container);
    this.renderer = new Renderer(this.container);

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
    // when Meet stops the camera, tear the compositor down
    source.getVideoTracks()[0]?.addEventListener('ended', () => {
      if (this.compositor === comp) {
        comp.stop();
        this.compositor = null;
      }
    });
    return out;
  }

  // snapshot the compositor paints each frame — empty unless actively drawing
  private renderState(): RenderState {
    const active = this.running && this.settings.mode === 'camera';
    return {
      shapes: active ? this.shapes : [],
      activeStroke: active ? this.activeStroke : null,
      color: this.settings.color,
      strokeWidth: this.settings.strokeWidth,
      cursor: active ? this.cursor : null,
      gesture: this.gesture,
    };
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
    if (patch.pinchThreshold !== undefined) this.recognizer.setThreshold(patch.pinchThreshold);

    const modeChanged = patch.mode !== undefined && patch.mode !== prev.mode;
    if (patch.enabled !== undefined && patch.enabled !== prev.enabled) {
      if (patch.enabled) await this.start();
      else this.stop();
    } else if (modeChanged && this.running) {
      // switching mode: coordinate spaces differ, so reset the canvas
      this.clearAll();
      this.renderer.clearLive();
    }
    this.emitStatus();
  }

  private async start() {
    if (this.running) return;
    this.lastError = undefined;
    controller.enabled = true;
    controller.mode = this.settings.mode;
    this.emitStatus();
    try {
      installTrustedTypesPolicy();
      await this.tracker.init(this.base() + 'wasm', this.base() + 'models/hand_landmarker.task');
      await this.camera.start();
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
    // NB: leave the compositor running as a plain passthrough so Meet's video
    // doesn't freeze; it tears down when Meet stops the camera.
    this.emitStatus();
  }

  private clearAll() {
    this.shapes = [];
    this.renderer.renderStatic(this.shapes);
  }

  private undo() {
    this.shapes.pop();
    this.renderer.renderStatic(this.shapes);
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
    if (this.camera.ready && dims) {
      const landmarks = this.tracker.detect(this.camera.video, now);
      if (landmarks) {
        const reading = this.recognizer.read(landmarks);
        this.gesture = reading.gesture;
        const raw = this.toTarget(reading.indexTip, dims);
        this.cursor = this.cursorFilter.filter(raw.x, raw.y, now);
        if (this.settings.showDebug && !camMode) {
          debugPts = landmarks.map((l) => this.toTarget(l, dims));
        }
        this.updateDrawState(this.gesture, this.cursor);
      } else if (this.activeStroke) {
        this.commitStroke();
      }
    }

    // screen mode paints everything on the overlay; camera mode paints the
    // drawing on the compositor and keeps only the HUD on screen.
    this.renderer.renderLive({
      stroke: camMode ? null : this.activeStroke,
      color: this.settings.color,
      strokeWidth: this.settings.strokeWidth,
      cursor: camMode ? null : this.cursor,
      gesture: this.gesture,
      landmarks: debugPts,
      showDebug: this.settings.showDebug,
      fps: this.fps,
      mode: this.compositor || !camMode ? this.settings.mode : 'camera (toggle Meet cam)',
    });
  };

  private updateDrawState(gesture: Gesture, cursor: Point) {
    if (gesture === 'pinch') {
      if (!this.activeStroke) this.activeStroke = [];
      const last = this.activeStroke[this.activeStroke.length - 1];
      if (!last || Math.hypot(cursor.x - last.x, cursor.y - last.y) > 2) {
        this.activeStroke.push(cursor);
      }
    } else {
      if (this.activeStroke) this.commitStroke();
      if (gesture === 'palm') this.clearAll();
    }
  }

  private commitStroke() {
    const stroke = this.activeStroke;
    this.activeStroke = null;
    if (!stroke || stroke.length < 3) return;
    const shape = snapStroke(stroke, this.settings.shapeMode, this.settings.color, this.settings.strokeWidth);
    this.shapes.push(shape);
    if (this.settings.mode === 'screen') this.renderer.renderStatic(this.shapes);
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
