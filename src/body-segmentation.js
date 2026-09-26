// Person segmentation (MediaPipe multiclass selfie model) used for occlusion: skin, hair and face
// are redrawn on top of the garment so arms/hands/head stay in front of it.
// Categories: 0 background, 1 hair, 2 body-skin, 3 face-skin, 4 clothes, 5 others.
class BodySegmentation {
  constructor({ width = 320 } = {}) {
    this.segmenter = null; this.ready = false; this.lastTs = 0; this.width = width;
    this.input = document.createElement('canvas'); this.inputCtx = this.input.getContext('2d');
    this.maskCanvas = document.createElement('canvas'); this.maskCtx = this.maskCanvas.getContext('2d');
    this.hasMask = false;
  }
  async initialize() {
    const { vision, fileset } = await MediaPipeLoader.load();
    const modelAssetPath = MediaPipeLoader.modelUrl('selfie_multiclass_256x256.tflite');
    const make = (delegate) => vision.ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath, delegate }, runningMode: 'VIDEO', outputCategoryMask: true, outputConfidenceMasks: false
    });
    try { this.segmenter = await make('GPU'); } catch (gpuError) { this.segmenter = await make('CPU'); }
    this.ready = true;
    return true;
  }
  // Updates this.maskCanvas (alpha = skin/hair/face). Returns true when a new mask was produced.
  segment(video) {
    if (!this.ready || video.readyState < 2 || !video.videoWidth) return false;
    const w = this.width, h = Math.round(this.width * video.videoHeight / video.videoWidth);
    if (this.input.width !== w || this.input.height !== h) { this.input.width = w; this.input.height = h; }
    this.inputCtx.drawImage(video, 0, 0, w, h);
    const now = performance.now(); const ts = now <= this.lastTs ? this.lastTs + 1 : now; this.lastTs = ts;
    let result;
    try { result = this.segmenter.segmentForVideo(this.input, ts); } catch (error) { return false; }
    const mask = result && result.categoryMask;
    if (!mask) { if (result && result.close) result.close(); return false; }
    const cats = mask.getAsUint8Array(); const mw = mask.width, mh = mask.height;
    if (this.maskCanvas.width !== mw || this.maskCanvas.height !== mh) { this.maskCanvas.width = mw; this.maskCanvas.height = mh; }
    const img = this.maskCtx.createImageData(mw, mh); const d = img.data;
    for (let i = 0; i < cats.length; i++) { const c = cats[i]; const o = i * 4; d[o] = d[o + 1] = d[o + 2] = 255; d[o + 3] = (c === 1 || c === 2 || c === 3) ? 255 : 0; }
    this.maskCtx.putImageData(img, 0, 0);
    result.close();
    this.hasMask = true;
    return true;
  }
}
if (typeof window !== "undefined") window.BodySegmentation = BodySegmentation;
if (typeof module !== 'undefined') module.exports = { BodySegmentation };
