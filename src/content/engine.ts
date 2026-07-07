// MAIN-world engine: camera -> hand tracking -> gesture -> draw -> overlay.
// Runs in the page's main world so MediaPipe's WASM loader (which appends a
// <script> that runs in the main world) correctly sets ModuleFactory. It has NO
// access to chrome.* APIs — the isolated "bridge" content script feeds it
// settings/actions via DOM CustomEvents and the extension base URL via a
// data-attribute, and it reports status back the same way.
import { CameraManager } from './CameraManager';
import { HandTracker } from './HandTracker';
import { GestureRecognizer, type Gesture, type LM } from './gestures';
import { OneEuro2D } from './OneEuroFilter';
import { Renderer } from './Renderer';
import { snapStroke } from './shapeSnap';
import { DEFAULT_SETTINGS, type Point, type Settings, type Shape } from './types';

// DOM event channel names shared with bridge.ts
const EV_READY = 'gd:engine-ready';
const EV_CMD = 'gd:cmd'; // bridge -> engine  { kind, ... }
const EV_STATUS = 'gd:status'; // engine -> bridge { running, error }

type Cmd =
  | { kind: 'settings'; settings: Partial<Settings> }
  | { kind: 'clear' }
  | { kind: 'undo' };

// Google Meet enforces Trusted Types (require-trusted-types-for 'script'), so
// MediaPipe's WASM loader — which assigns a raw string to <script>.src — is
// blocked. A pass-through *default* policy sanitizes raw-string sink
// assignments. It only fires for raw strings (Meet's own TT-compliant code
// never assigns those), so it doesn't alter Meet's behavior. If Meet's CSP
// allowlists policy names and forbids 'default', createPolicy throws — caught
// upstream and surfaced, at which point the offscreen-document fallback is next.
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
    throw new Error(
      `Trusted Types blocked our policy — Meet forbids it. Needs offscreen fallback. (${
        (e as Error).message
      })`,
    );
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

  private shapes: Shape[] = [];
  private activeStroke: Point[] | null = null;
  private running = false;
  private rafId = 0;
  private lastError: string | undefined;

  private frameCount = 0;
  private fps = 0;
  private lastFpsT = performance.now();

  // base like "chrome-extension://<id>/", provided by the bridge
  private base(): string {
    return document.documentElement.dataset.gdBase ?? '';
  }

  init() {
    this.container = document.createElement('div');
    this.container.id = 'gesture-draw-root';
    document.documentElement.appendChild(this.container);
    this.renderer = new Renderer(this.container);

    window.addEventListener(EV_CMD, (e) => this.onCmd((e as CustomEvent<Cmd>).detail));
    this.wireKeyboard();

    // tell the bridge we're alive so it sends current settings
    window.dispatchEvent(new CustomEvent(EV_READY));
    this.emitStatus();
  }

  private emitStatus() {
    window.dispatchEvent(
      new CustomEvent(EV_STATUS, { detail: { running: this.running, error: this.lastError } }),
    );
  }

  private onCmd(cmd: Cmd) {
    switch (cmd.kind) {
      case 'settings':
        this.applySettings(cmd.settings);
        break;
      case 'clear':
        this.clearAll();
        break;
      case 'undo':
        this.undo();
        break;
    }
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
    if (patch.pinchThreshold !== undefined) this.recognizer.setThreshold(patch.pinchThreshold);
    if (patch.enabled !== undefined && patch.enabled !== prev.enabled) {
      if (patch.enabled) await this.start();
      else this.stop();
    }
  }

  private async start() {
    if (this.running) return;
    this.lastError = undefined;
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
      console.error('[GestureDraw] start failed:', err);
    }
    this.emitStatus();
  }

  private stop() {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    this.camera.stop();
    this.tracker.close();
    this.activeStroke = null;
    this.renderer.clearLive();
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

  // normalized landmark -> screen px (webcam mirrored so motion feels natural)
  private toScreen(lm: LM): Point {
    return { x: (1 - lm.x) * window.innerWidth, y: lm.y * window.innerHeight };
  }

  private loop = () => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.loop);
    const now = performance.now();
    this.tickFps(now);

    if (!this.camera.ready) return;
    const landmarks = this.tracker.detect(this.camera.video, now);

    let gesture: Gesture = 'idle';
    let cursor: Point | null = null;
    let debugPts: Point[] | undefined;

    if (landmarks) {
      const reading = this.recognizer.read(landmarks);
      gesture = reading.gesture;
      const raw = this.toScreen(reading.indexTip);
      cursor = this.cursorFilter.filter(raw.x, raw.y, now);
      if (this.settings.showDebug) debugPts = landmarks.map((l) => this.toScreen(l));
      this.updateDrawState(gesture, cursor);
    } else if (this.activeStroke) {
      this.commitStroke();
    }

    this.renderer.renderLive({
      stroke: this.activeStroke,
      color: this.settings.color,
      strokeWidth: this.settings.strokeWidth,
      cursor,
      gesture,
      landmarks: debugPts,
      showDebug: this.settings.showDebug,
      fps: this.fps,
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
    const shape = snapStroke(
      stroke,
      this.settings.shapeMode,
      this.settings.color,
      this.settings.strokeWidth,
    );
    this.shapes.push(shape);
    this.renderer.renderStatic(this.shapes);
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

if (!(window as any).__gestureDrawEngine) {
  (window as any).__gestureDrawEngine = true;
  const start = () => new Engine().init();
  // wait until the bridge has stamped the base URL onto <html>
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
