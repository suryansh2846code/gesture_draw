// Wraps MediaPipe Tasks-Vision HandLandmarker. WASM + model are loaded from the
// bundled extension resources (never Google's CDN). Runs in the page MAIN world,
// so absolute chrome-extension:// URLs are passed in (no chrome.* here).
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import type { LM } from './gestures';
import type { Handed } from './types';

export interface HandDetection {
  landmarks: LM[];
  handedness: Handed;
}

export class HandTracker {
  private landmarker: HandLandmarker | null = null;
  private lastVideoTime = -1;

  // wasmBase e.g. "chrome-extension://<id>/wasm", modelUrl the .task file URL
  async init(wasmBase: string, modelUrl: string): Promise<void> {
    const fileset = await FilesetResolver.forVisionTasks(wasmBase);
    this.landmarker = await HandLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: modelUrl,
        delegate: 'GPU',
      },
      numHands: 2,
      runningMode: 'VIDEO',
      minHandDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
  }

  // returns detected hands (with handedness); [] = new frame, no hands;
  // null = no new frame (same video time) so callers should keep prior state.
  detect(video: HTMLVideoElement, timestampMs: number): HandDetection[] | null {
    if (!this.landmarker) return null;
    if (video.currentTime === this.lastVideoTime) return null;
    this.lastVideoTime = video.currentTime;
    const res = this.landmarker.detectForVideo(video, timestampMs);
    const hands = res.landmarks ?? [];
    const out: HandDetection[] = [];
    for (let i = 0; i < hands.length; i++) {
      const label = res.handedness?.[i]?.[0]?.categoryName;
      out.push({ landmarks: hands[i] as LM[], handedness: label === 'Left' ? 'Left' : 'Right' });
    }
    return out;
  }

  close() {
    this.landmarker?.close();
    this.landmarker = null;
  }
}
