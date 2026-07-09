import type { Gesture } from './gestures';

export interface Point {
  x: number;
  y: number;
}

export type Shape =
  | { kind: 'free'; pts: Point[]; color: string; w: number }
  | { kind: 'rect'; x: number; y: number; w: number; h: number; color: string }
  | { kind: 'circle'; cx: number; cy: number; r: number; color: string }
  | { kind: 'line' | 'arrow'; from: Point; to: Point; color: string }
  | { kind: 'text'; x: number; y: number; h: number; text: string; color: string; mirror?: boolean };

export type ShapeMode = 'auto' | 'free' | 'rect' | 'circle' | 'line' | 'arrow' | 'text';

// 'screen'  -> overlay on the whole screen; others see it via screen-share.
// 'camera'  -> composited onto your webcam feed; others see it on your tile.
export type DrawMode = 'screen' | 'camera';

// which hand draws; the other hand erases. (MediaPipe handedness can appear
// flipped depending on mirroring, so this is user-swappable.)
export type Handed = 'Right' | 'Left';

export interface Settings {
  enabled: boolean;
  mode: DrawMode;
  drawHand: Handed; // this hand draws (index up); the other erases
  color: string;
  strokeWidth: number;
  shapeMode: ShapeMode;
  pinchThreshold: number; // fraction of palm size; smaller = harder to trigger
  smoothing: number; // 0 = responsive, 1 = very steady (kills hand jitter)
  showDebug: boolean; // draw landmarks + gesture HUD
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: false,
  mode: 'camera',
  drawHand: 'Right',
  color: '#ff375f',
  strokeWidth: 4,
  shapeMode: 'auto',
  pinchThreshold: 0.35,
  smoothing: 0.7,
  showDebug: true,
};

// per-frame live state the compositor paints on top of the cached ink layer.
// (committed shapes are rendered separately via CameraCompositor.renderInk so
// they aren't re-rasterized every frame.)
export interface RenderState {
  activeStroke: Point[] | null;
  bufferStrokes: Point[][]; // finished strokes awaiting character recognition
  color: string;
  strokeWidth: number;
  cursor: Point | null;
  eraseCursor: Point | null;
  eraseRadius: number;
  selection: { x: number; y: number; w: number; h: number } | null;
  gesture: Gesture;
}

export const SETTINGS_KEY = 'gd_settings';

// messages between popup <-> content
export type Msg =
  | { type: 'settings:update'; settings: Partial<Settings> }
  | { type: 'action:clear' }
  | { type: 'action:undo' }
  | { type: 'action:status'; }
  | { type: 'status:reply'; running: boolean; error?: string };
