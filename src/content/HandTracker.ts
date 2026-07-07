// Wraps MediaPipe Tasks-Vision HandLandmarker. WASM + model are loaded from the
// bundled extension resources (never Google's CDN) via chrome.runtime.getURL.
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import type { LM } from './gestures';

export class HandTracker {
  private landmarker: HandLandmarker | null = null;
  private lastVideoTime = -1;

  async init(): Promise<void> {
    const fileset = await FilesetResolver.forVisionTasks(chrome.runtime.getURL('wasm'));
    this.landmarker = await HandLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: chrome.runtime.getURL('models/hand_landmarker.task'),
        delegate: 'GPU',
      },
      numHands: 1,
      runningMode: 'VIDEO',
      minHandDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
  }

  // returns 21 landmarks for the first detected hand, or null.
  detect(video: HTMLVideoElement, timestampMs: number): LM[] | null {
    if (!this.landmarker) return null;
    if (video.currentTime === this.lastVideoTime) return null;
    this.lastVideoTime = video.currentTime;
    const res = this.landmarker.detectForVideo(video, timestampMs);
    if (!res.landmarks || res.landmarks.length === 0) return null;
    return res.landmarks[0] as LM[];
  }

  close() {
    this.landmarker?.close();
    this.landmarker = null;
  }
}
