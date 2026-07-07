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

export interface Settings {
  enabled: boolean;
  color: string;
  strokeWidth: number;
  shapeMode: ShapeMode;
  pinchThreshold: number; // fraction of palm size; smaller = harder to trigger
  showDebug: boolean; // draw landmarks + gesture HUD
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: false,
  color: '#ff375f',
  strokeWidth: 4,
  shapeMode: 'auto',
  pinchThreshold: 0.35,
  showDebug: true,
};

export const SETTINGS_KEY = 'gd_settings';

// messages between popup <-> content
export type Msg =
  | { type: 'settings:update'; settings: Partial<Settings> }
  | { type: 'action:clear' }
  | { type: 'action:undo' }
  | { type: 'action:status'; }
  | { type: 'status:reply'; running: boolean; error?: string };
