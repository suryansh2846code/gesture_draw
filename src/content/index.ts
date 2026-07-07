// Content-script orchestrator: camera -> hand tracking -> gesture -> draw state
// machine -> overlay. Runs entirely on Google Meet pages, on-device.
import { CameraManager } from './CameraManager';
import { HandTracker } from './HandTracker';
import { GestureRecognizer, type Gesture, type LM } from './gestures';
import { OneEuro2D } from './OneEuroFilter';
import { Renderer } from './Renderer';
import { snapStroke } from './shapeSnap';
import {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  type Msg,
  type Point,
  type Settings,
  type Shape,
} from './types';

class GestureDraw {
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

  // fps meter
  private frameCount = 0;
  private fps = 0;
  private lastFpsT = performance.now();

  async init() {
    this.settings = await this.loadSettings();
    this.recognizer.setThreshold(this.settings.pinchThreshold);

    this.container = document.createElement('div');
    this.container.id = 'gesture-draw-root';
    document.documentElement.appendChild(this.container);
    this.renderer = new Renderer(this.container);

    this.wireMessaging();
    this.wireKeyboard();

    if (this.settings.enabled) await this.start();
  }

  private async loadSettings(): Promise<Settings> {
    const got = await chrome.storage.sync.get(SETTINGS_KEY);
    return { ...DEFAULT_SETTINGS, ...(got[SETTINGS_KEY] ?? {}) };
  }

  private wireMessaging() {
    chrome.runtime.onMessage.addListener((msg: Msg, _s, reply) => {
      (async () => {
        switch (msg.type) {
          case 'settings:update':
            await this.applySettings(msg.settings);
            break;
          case 'action:clear':
            this.clearAll();
            break;
          case 'action:undo':
            this.undo();
            break;
          case 'action:status':
            reply({ type: 'status:reply', running: this.running, error: this.lastError });
            return;
        }
        reply({ type: 'status:reply', running: this.running, error: this.lastError });
      })();
      return true; // async reply
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync' && changes[SETTINGS_KEY]) {
        this.applySettings(changes[SETTINGS_KEY].newValue ?? {});
      }
    });
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
    try {
      await this.tracker.init();
      await this.camera.start();
      this.running = true;
      this.loop();
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.running = false;
      console.error('[GestureDraw] start failed:', err);
    }
  }

  private stop() {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    this.camera.stop();
    this.tracker.close();
    this.activeStroke = null;
    this.renderer.clearLive();
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
    } else {
      // hand left frame: commit any in-progress stroke
      if (this.activeStroke) this.commitStroke();
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

  // IDLE -> DRAWING (pinch) -> SNAP+COMMIT (release). palm = clear.
  private updateDrawState(gesture: Gesture, cursor: Point) {
    if (gesture === 'pinch') {
      if (!this.activeStroke) this.activeStroke = [];
      const last = this.activeStroke[this.activeStroke.length - 1];
      // drop near-duplicate points to keep strokes light
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

// guard against double-injection on SPA navigations
if (!(window as any).__gestureDrawLoaded) {
  (window as any).__gestureDrawLoaded = true;
  const app = new GestureDraw();
  app.init().catch((e) => console.error('[GestureDraw] init error', e));
}
