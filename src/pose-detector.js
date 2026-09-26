// Pose tracking: MediaPipe Pose Landmarker + One Euro smoothing so the garment does not jitter.
class OneEuroFilter {
  constructor(minCutoff = 1.4, beta = 2.5, dCutoff = 1.0) { this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff; this.x = null; this.dx = 0; this.t = null; }
  static alpha(cutoff, dt) { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); }
  filter(value, t) {
    if (this.x === null) { this.x = value; this.t = t; return value; }
    const dt = Math.max(1e-3, t - this.t); this.t = t;
    const dValue = (value - this.x) / dt;
    this.dx += OneEuroFilter.alpha(this.dCutoff, dt) * (dValue - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuroFilter.alpha(cutoff, dt) * (value - this.x);
    return this.x;
  }
  reset() { this.x = null; }
}

class PoseDetector {
  constructor(options = {}) {
    this.options = options; this.ready = false; this.landmarker = null; this.lastTs = 0; this.lostFrames = 0;
    this.filters = []; this.lastLandmarks = null; this.error = null;
  }
  async initialize() {
    const { vision, fileset } = await MediaPipeLoader.load();
    const modelAssetPath = MediaPipeLoader.modelUrl('pose_landmarker_lite.task');
    const make = (delegate) => vision.PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath, delegate }, runningMode: 'VIDEO', numPoses: 1,
      minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5
    });
    try { this.landmarker = await make('GPU'); } catch (gpuError) { this.landmarker = await make('CPU'); }
    this.ready = true;
    return true;
  }
  smooth(landmarks, tSec) {
    return landmarks.map((p, i) => {
      const f = this.filters[i] || (this.filters[i] = { x: new OneEuroFilter(), y: new OneEuroFilter() });
      return { x: f.x.filter(p.x, tSec), y: f.y.filter(p.y, tSec), z: p.z, visibility: p.visibility };
    });
  }
  async detect(video) {
    if (!this.ready || !this.landmarker || video.readyState < 2) return { landmarks: this.lastLandmarks };
    const now = performance.now();
    const ts = now <= this.lastTs ? this.lastTs + 1 : now; this.lastTs = ts;
    let result;
    try { result = this.landmarker.detectForVideo(video, ts); } catch (error) { this.error = error; return { landmarks: null }; }
    const raw = result && result.landmarks && result.landmarks[0];
    if (raw) { this.lostFrames = 0; this.lastLandmarks = this.smooth(raw, ts / 1000); return { landmarks: this.lastLandmarks, raw: result }; }
    this.lostFrames += 1;
    if (this.lostFrames > 4) { this.lastLandmarks = null; this.filters = []; }
    return { landmarks: this.lastLandmarks, lost: this.lostFrames };
  }
}
if (typeof window !== "undefined") { window.PoseDetector = PoseDetector; window.OneEuroFilter = OneEuroFilter; }
if (typeof module !== 'undefined') module.exports = { PoseDetector, OneEuroFilter };
