// Pure geometry over MediaPipe's 21 hand landmarks -> a stable gesture.
// Landmark indices (MediaPipe Hands):
//  0 wrist | 4 thumb tip | 8 index tip | 12 middle tip | 16 ring tip | 20 pinky tip
//  5 index_mcp | 9 middle_mcp | 13 ring_mcp | 17 pinky_mcp

export interface LM {
  x: number;
  y: number;
  z: number;
}

export type Gesture = 'idle' | 'point' | 'pinch' | 'palm' | 'fist';

const dist = (a: LM, b: LM) => Math.hypot(a.x - b.x, a.y - b.y);

// palm size = wrist -> middle_mcp; used to normalize all thresholds so that
// distance-from-camera doesn't change behavior.
function palmSize(lm: LM[]): number {
  return Math.max(dist(lm[0], lm[9]), 1e-4);
}

// a finger is "extended" if its tip is farther from the wrist than its pip joint.
function fingerExtended(lm: LM[], tip: number, pip: number): boolean {
  return dist(lm[tip], lm[0]) > dist(lm[pip], lm[0]) * 1.05;
}

export interface GestureReading {
  gesture: Gesture;
  pinchDist: number; // normalized thumb-index distance
  indexTip: LM;
}

// Hysteresis: pinch is "sticky" once engaged so it doesn't flicker at the edge.
export class GestureRecognizer {
  private pinched = false;

  constructor(private pinchThreshold = 0.35) {}

  setThreshold(t: number) {
    this.pinchThreshold = t;
  }

  read(lm: LM[]): GestureReading {
    const ps = palmSize(lm);
    const pinchDist = dist(lm[4], lm[8]) / ps;

    const enter = this.pinchThreshold;
    const exit = this.pinchThreshold * 1.5; // wider gap = less flicker
    if (!this.pinched && pinchDist < enter) this.pinched = true;
    else if (this.pinched && pinchDist > exit) this.pinched = false;

    const indexExt = fingerExtended(lm, 8, 6);
    const middleExt = fingerExtended(lm, 12, 10);
    const ringExt = fingerExtended(lm, 16, 14);
    const pinkyExt = fingerExtended(lm, 20, 18);
    const extended = [indexExt, middleExt, ringExt, pinkyExt].filter(Boolean).length;

    let gesture: Gesture;
    if (this.pinched) {
      gesture = 'pinch';
    } else if (extended >= 4) {
      gesture = 'palm';
    } else if (extended === 0) {
      gesture = 'fist';
    } else if (indexExt && !middleExt) {
      gesture = 'point';
    } else {
      gesture = 'idle';
    }

    return { gesture, pinchDist, indexTip: lm[8] };
  }
}
