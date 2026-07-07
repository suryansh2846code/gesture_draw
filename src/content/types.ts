import type { Gesture } from './gestures';

export interface Point {
  x: number;
  y: number;
}

export type Shape =
  | { kind: 'free'; pts: Point[]; color: string; w: number }
  | { kind: 'rect'; x: number; y: number; w: number; h: number; color: string }
  | { kind: 'circle'; cx: number; cy: number; r: number; color: string }
  | { kind: 'line' | 'arrow'; from: Point; to: Point; color: string };

export type ShapeMode = 'auto' | 'free' | 'rect' | 'circle' | 'line' | 'arrow';

// 'screen'  -> overlay on the whole screen; others see it via screen-share.
// 'camera'  -> composited onto your webcam feed; others see it on your tile.
export type DrawMode = 'screen' | 'camera';

export interface Settings {
  enabled: boolean;
  mode: DrawMode;
  color: string;
  strokeWidth: number;
  shapeMode: ShapeMode;
  pinchThreshold: number; // fraction of palm size; smaller = harder to trigger
  showDebug: boolean; // draw landmarks + gesture HUD
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: false,
  mode: 'camera',
  color: '#ff375f',
  strokeWidth: 4,
  shapeMode: 'auto',
  pinchThreshold: 0.35,
  showDebug: true,
};

// snapshot the compositor reads each frame to paint onto the webcam canvas
export interface RenderState {
  shapes: Shape[];
  activeStroke: Point[] | null;
  color: string;
  strokeWidth: number;
  cursor: Point | null;
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
