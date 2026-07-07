// Owns the webcam stream feeding hand tracking. Requests a low-res stream since
// hand tracking doesn't need HD and it roughly halves inference cost.
export class CameraManager {
  private stream: MediaStream | null = null;
  readonly video: HTMLVideoElement;

  constructor() {
    this.video = document.createElement('video');
    this.video.autoplay = true;
    this.video.playsInline = true;
    this.video.muted = true;
    // must be in the DOM (not display:none) for some browsers to run the pipeline
    Object.assign(this.video.style, {
      position: 'fixed',
      width: '1px',
      height: '1px',
      opacity: '0',
      pointerEvents: 'none',
      top: '0',
      left: '0',
    } as CSSStyleDeclaration);
    document.documentElement.appendChild(this.video);
  }

  async start(): Promise<void> {
    // NOTE: Meet is also using the camera. Most browsers allow multiple
    // consumers of the same device; if this throws, that's the contention
    // risk from the spec — surfaced to the user via the popup.
    // Use the ORIGINAL getUserMedia (stashed by the engine's patch) so this
    // tracking stream isn't itself intercepted and composited.
    const md = navigator.mediaDevices as MediaDevices & {
      __gdRealGUM?: (c?: MediaStreamConstraints) => Promise<MediaStream>;
    };
    const gum = (md.__gdRealGUM ?? md.getUserMedia).bind(md);
    this.stream = await gum({
      video: { width: 640, height: 480, frameRate: 30, facingMode: 'user' },
      audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play();
    // wait until we actually have frame dimensions
    if (this.video.readyState < 2) {
      await new Promise<void>((res) => {
        this.video.onloadeddata = () => res();
      });
    }
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.video.remove();
  }

  get ready(): boolean {
    return !!this.stream && this.video.readyState >= 2;
  }
}
