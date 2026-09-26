class PoseDetector {
  constructor(options = {}) { this.options = options; this.ready = false; this.lastLandmarks = null; this.landmarker = null; }
  async initialize() {
    // The adapter is local and has no remote script dependency. If a locally bundled
    // MediaPipe PoseLandmarker runtime is added, expose it as window.PoseLandmarkerRuntime
    // and this class will use its create/detect API.
    this.landmarker = window.PoseLandmarkerRuntime || null;
    this.ready = true;
    return true;
  }
  async detect(video) {
    if (this.landmarker?.detectForVideo) {
      const result = this.landmarker.detectForVideo(video, performance.now());
      this.lastLandmarks = result?.landmarks?.[0] || null;
      return { landmarks: this.lastLandmarks, raw: result };
    }
    return { landmarks: this.lastLandmarks };
  }
}
window.PoseDetector = PoseDetector;
