// Person segmentation (MediaPipe multiclass selfie model) used for occlusion: skin, hair and face
// are redrawn on top of the garment so arms/hands/head stay in front of it.
// Categories: 0 background, 1 hair, 2 body-skin, 3 face-skin, 4 clothes, 5 others.
class BodySegmentation {
  constructor({ width = 320 } = {}) {
    this.segmenter = null; this.ready = false; this.lastTs = 0; this.width = width;
    this.input = document.createElement('canvas'); this.inputCtx = this.input.getContext('2d');
    this.maskCanvas = document.createElement('canvas'); this.maskCtx = this.maskCanvas.getContext('2d');
    this.hasMask = false; this.lastCats = null; this.lastW = 0; this.lastH = 0;
    this.imageSegmenter = null; this.imgInput = document.createElement('canvas'); this.imgCtx = this.imgInput.getContext('2d', { willReadFrequently: true });
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
    this.lastCats = Uint8Array.from(cats); this.lastW = mw; this.lastH = mh;
    if (this.maskCanvas.width !== mw || this.maskCanvas.height !== mh) { this.maskCanvas.width = mw; this.maskCanvas.height = mh; }
    const img = this.maskCtx.createImageData(mw, mh); const d = img.data;
    for (let i = 0; i < cats.length; i++) { const c = cats[i]; const o = i * 4; d[o] = d[o + 1] = d[o + 2] = 255; d[o + 3] = (c === 1 || c === 2 || c === 3) ? 255 : 0; }
    this.maskCtx.putImageData(img, 0, 0);
    result.close();
    this.hasMask = true;
    return true;
  }
  // Mean RGB of the skin pixels (face + body) of the latest video frame: a cheap "light probe" for relighting.
  skinColor() { return BodySegmentation.meanColor(this.inputCtx, this.lastCats, this.lastW, this.lastH, [2, 3]); }

  static meanColor(ctx, cats, w, h, classes) {
    if (!cats) return null;
    let img; try { img = ctx.getImageData(0, 0, w, h).data; } catch (error) { return null; }
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < cats.length; i++) if (classes.includes(cats[i])) { r += img[i * 4]; g += img[i * 4 + 1]; b += img[i * 4 + 2]; n++; }
    return n > 20 ? [r / n, g / n, b / n] : null;
  }

  // Still image (the AI keyframe or the frozen photo): returns { cats, width, height, skinColor }.
  async segmentImage(source, size = 256) {
    if (!this.imageSegmenter) {
      const { vision, fileset } = await MediaPipeLoader.load();
      const modelAssetPath = MediaPipeLoader.modelUrl('selfie_multiclass_256x256.tflite');
      const make = (delegate) => vision.ImageSegmenter.createFromOptions(fileset, { baseOptions: { modelAssetPath, delegate }, runningMode: 'IMAGE', outputCategoryMask: true, outputConfidenceMasks: false });
      try { this.imageSegmenter = await make('GPU'); } catch (gpuError) { this.imageSegmenter = await make('CPU'); }
    }
    const sw = source.width, sh = source.height, k = size / Math.max(sw, sh);
    const w = Math.max(8, Math.round(sw * k)), h = Math.max(8, Math.round(sh * k));
    this.imgInput.width = w; this.imgInput.height = h; this.imgCtx.drawImage(source, 0, 0, w, h);
    const result = this.imageSegmenter.segment(this.imgInput);
    const mask = result.categoryMask; const cats = Uint8Array.from(mask.getAsUint8Array()); const mw = mask.width, mh = mask.height; result.close();
    return { cats, width: mw, height: mh, skinColor: BodySegmentation.meanColor(this.imgCtx, cats, mw, mh, [2, 3]) };
  }
}
if (typeof window !== "undefined") window.BodySegmentation = BodySegmentation;
if (typeof module !== 'undefined') module.exports = { BodySegmentation };
