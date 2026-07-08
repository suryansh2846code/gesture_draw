// 1€ filter (Casiez et al.) — the standard low-latency smoothing for jittery
// input like hand landmarks. One instance per scalar signal.
class LowPass {
  private y: number | null = null;
  filter(x: number, alpha: number): number {
    this.y = this.y === null ? x : alpha * x + (1 - alpha) * this.y;
    return this.y;
  }
  last(): number | null {
    return this.y;
  }
}

export class OneEuro {
  private xFilt = new LowPass();
  private dxFilt = new LowPass();
  private lastTime: number | null = null;
  private lastX: number | null = null;

  constructor(
    private minCutoff = 1.0,
    private beta = 0.007,
    private dCutoff = 1.0,
  ) {}

  setParams(minCutoff: number, beta: number) {
    this.minCutoff = minCutoff;
    this.beta = beta;
  }

  private alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  filter(x: number, timestampMs: number): number {
    if (this.lastTime === null) {
      this.lastTime = timestampMs;
      this.lastX = x;
      this.xFilt.filter(x, 1);
      return x;
    }
    let dt = (timestampMs - this.lastTime) / 1000;
    if (dt <= 0) dt = 1 / 60;
    this.lastTime = timestampMs;

    const dx = (x - (this.lastX ?? x)) / dt;
    this.lastX = x;
    const edx = this.dxFilt.filter(dx, this.alpha(this.dCutoff, dt));
    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    return this.xFilt.filter(x, this.alpha(cutoff, dt));
  }
}

// convenience: filter a 2D point
export class OneEuro2D {
  private fx: OneEuro;
  private fy: OneEuro;
  constructor(minCutoff = 1.0, beta = 0.007) {
    this.fx = new OneEuro(minCutoff, beta);
    this.fy = new OneEuro(minCutoff, beta);
  }
  setParams(minCutoff: number, beta: number) {
    this.fx.setParams(minCutoff, beta);
    this.fy.setParams(minCutoff, beta);
  }
  filter(x: number, y: number, t: number): { x: number; y: number } {
    return { x: this.fx.filter(x, t), y: this.fy.filter(y, t) };
  }
}

// Map a 0..1 "smoothness" dial to 1€ filter params. Higher = steadier (less
// jitter, a little more lag); lower = more responsive. Cutoff dominates rest
// jitter, so it's the main lever.
export function smoothingToParams(s: number): { minCutoff: number; beta: number } {
  const t = Math.min(1, Math.max(0, s));
  return {
    minCutoff: 2.2 - 1.9 * t, // 2.2 (snappy) -> 0.3 (very smooth)
    beta: 0.05 - 0.045 * t, // 0.05 -> 0.005
  };
}
