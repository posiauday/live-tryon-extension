// Free mode ("your PC"): AI keyframes + live tracking.
//
//   drop a garment -> 3-2-1 -> freeze a frame -> local AI server makes a photo of YOU in the garment (the keyframe) ->
//   cut the garment out of it -> every video frame: track your pose, bend the garment onto you (MLS warp on a mesh),
//   let the fabric follow real texture (local Lucas-Kanade), match the room light, draw your arms/head over it.
//   When you move to a pose no stored keyframe covers, another keyframe is generated in the background (a small bank of
//   poses), and the nearest one is used (cross-faded near boundaries).
//
// Uses (loaded before this file): FreeMLS, FreeBank, FreeGarment, FreeFlow, FreeRenderer, FreeBackend.
const FREE_COLS = 12, FREE_ROWS = 14, FREE_WORK_W = 320, KEY_W = 576, KEY_H = 768;

const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// A 3:4 portrait crop around the torso (what try-on models expect), in frame pixels.
function portraitCrop(lm, W, H) {
  const l = lm[11], r = lm[12];
  const sw = Math.hypot((l.x - r.x) * W, (l.y - r.y) * H);
  const mx = ((l.x + r.x) / 2) * W, my = ((l.y + r.y) / 2) * H;
  let ch = Math.min(H, Math.max(sw * 3.2, 240)), cw = (ch * 3) / 4;
  if (cw > W) { cw = W; ch = (cw * 4) / 3; }
  const x = clampN(mx - cw / 2, 0, W - cw), y = clampN(my - ch * 0.3, 0, H - ch);
  return { x: Math.round(x), y: Math.round(y), w: Math.round(cw), h: Math.round(ch) };
}

const canvasOf = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
const toBlob = (canvas, type = 'image/png', q) => new Promise((resolve) => canvas.toBlob(resolve, type, q));
const visible = (p) => p && (p.visibility === undefined || p.visibility >= 0.5);

class FreePipeline {
  constructor({ video, canvas, detector, segmenter, backend, onEvent = () => {}, options = {} }) {
    this.video = video; this.canvas = canvas; this.ctx = canvas.getContext('2d');
    this.detector = detector; this.segmenter = segmenter; this.backend = backend; this.emit = onEvent;
    this.options = Object.assign({ tracking: false, autoAngles: true, maxKeyframes: 6, countdown: 3, forceFallbackRenderer: false }, options);
    this.bank = new FreeBank.KeyframeBank({ max: this.options.maxKeyframes });
    this.phase = 'idle'; this.garmentBlob = null; this.kind = 'shirt';
    this.renderer = null; this.landmarks = null; this.frame = 0; this.fade = 0; this.job = null;
    this.countdownEnd = null; this.lastCount = null; this.gain = [1, 1, 1]; this.liveSkin = null;
    this.stillRef = null; this.angleCooldownUntil = 0;
    this.work = canvasOf(FREE_WORK_W, 180); this.workCtx = this.work.getContext('2d', { willReadFrequently: true });
    this.curGray = null; this.curGrayFrame = -1; this.skin = canvasOf(2, 2); this.skinCtx = this.skin.getContext('2d');
    this.indices = FreeRenderer.gridIndices(FREE_COLS, FREE_ROWS); this.stats = { renderMs: 0 };
  }

  setPhase(phase) { if (this.phase !== phase) { this.phase = phase; this.emit('phase', { phase }); } }
  status() { return { phase: this.phase, keyframes: this.bank.size, busy: !!this.job, renderer: this.renderer && this.renderer.kind, renderMs: this.stats.renderMs }; }

  // ---------- user actions ----------
  setGarment(blob, kind = 'shirt') {
    this.reset();
    this.garmentBlob = blob; this.kind = kind; this.countdownEnd = null; this.lastCount = null;
    this.setPhase('countdown');
  }
  reset() {
    if (this.job) { this.job.abort.abort(); this.job = null; }
    if (this.renderer) for (const e of this.bank.entries) this.renderer.forget(e.garment);
    this.bank.clear(); this.garmentBlob = null; this.fade = 0; this.countdownEnd = null; this.stillRef = null;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.setPhase('idle');
  }

  // ---------- keyframes ----------
  shouldersVisible() {
    const lm = this.landmarks; if (!lm) return false;
    return visible(lm[11]) && visible(lm[12]) && [lm[11], lm[12]].every((p) => p.x > 0.02 && p.x < 0.98 && p.y > 0.02 && p.y < 0.98);
  }

  async captureKeyframe(reason) {
    const W = this.video.videoWidth, H = this.video.videoHeight;
    const lm = this.landmarks && this.landmarks.map((p) => ({ ...p }));
    if (!lm || !this.shouldersVisible()) throw new Error('I cannot see your shoulders. Step back a little and face the camera.');
    if (!this.segmenter || !this.segmenter.ready) throw new Error('The body-segmentation model is not ready yet.');
    const crop = portraitCrop(lm, W, H);
    const frame = canvasOf(W, H); frame.getContext('2d').drawImage(this.video, 0, 0, W, H);   // frozen frame
    const person = canvasOf(768, 1024); person.getContext('2d').drawImage(frame, crop.x, crop.y, crop.w, crop.h, 0, 0, 768, 1024);
    const personBlob = await toBlob(person);
    const job = { abort: new AbortController(), startedAt: performance.now(), reason }; this.job = job;
    this.emit('generating', { reason, startedAt: job.startedAt });
    const { blob: keyBlob, seconds, engine } = await this.backend.generate({ person: personBlob, garment: this.garmentBlob, category: FreeBackend.KIND_TO_CATEGORY[this.kind] || 'upper', signal: job.abort.signal });
    if (job !== this.job) return null; // cancelled or superseded

    // work at KEY_W x KEY_H (3:4): the keyframe, and the frozen person crop at the same size
    const keyBitmap = await createImageBitmap(keyBlob);
    const keyCanvas = canvasOf(KEY_W, KEY_H); keyCanvas.getContext('2d').drawImage(keyBitmap, 0, 0, KEY_W, KEY_H);
    const personSmall = canvasOf(KEY_W, KEY_H); personSmall.getContext('2d').drawImage(person, 0, 0, KEY_W, KEY_H);
    const seg = await this.segmenter.segmentImage(keyCanvas);
    const segPerson = await this.segmenter.segmentImage(personSmall);
    const res = FreeGarment.garmentAlpha({
      key: keyCanvas.getContext('2d').getImageData(0, 0, KEY_W, KEY_H), person: personSmall.getContext('2d').getImageData(0, 0, KEY_W, KEY_H),
      cats: seg.cats, catsW: seg.width, catsH: seg.height
    });
    if (!res.bbox || res.coverage < 0.02) throw new Error('I could not find the garment in the result. Try again or use another product photo.');
    if (job !== this.job) return null;
    const garment = FreeGarment.makeGarmentCanvas(keyCanvas, res);

    const kx = crop.w / KEY_W, ky = crop.h / KEY_H;                        // key space -> frame pixels
    const bbox = { x: crop.x + res.bbox.x * kx, y: crop.y + res.bbox.y * ky, w: res.bbox.w * kx, h: res.bbox.h * ky };
    const grid = FreeMLS.makeGrid(bbox, FREE_COLS, FREE_ROWS);
    const active = new Uint8Array(FREE_COLS * FREE_ROWS);                  // which vertices lie on the garment (worth tracking)
    for (let j = 0; j < FREE_ROWS; j++) for (let i = 0; i < FREE_COLS; i++) {
      const x = Math.min(KEY_W - 1, Math.round(res.bbox.x + (i / (FREE_COLS - 1)) * res.bbox.w)), y = Math.min(KEY_H - 1, Math.round(res.bbox.y + (j / (FREE_ROWS - 1)) * res.bbox.h));
      active[j * FREE_COLS + i] = res.alpha[y * KEY_W + x] ? 1 : 0;
    }
    const s = FREE_WORK_W / W; const wh = Math.round(H * s);
    const grayCanvas = canvasOf(FREE_WORK_W, wh); grayCanvas.getContext('2d').drawImage(frame, 0, 0, FREE_WORK_W, wh);
    const refGray = FreeFlow.toGray(grayCanvas.getContext('2d').getImageData(0, 0, FREE_WORK_W, wh));
    const entry = { id: `${reason}-${Date.now()}`, reason, seconds, engine, landmarks: lm, grid, bbox, garment, active, refGray, refLight: segPerson.skinColor, refiner: new FreeFlow.MeshRefiner(), coverage: res.coverage };
    entry.refiner.setReference(refGray);
    const before = this.bank.entries.slice(); this.bank.add(entry);
    if (this.renderer) for (const e of before) if (!this.bank.entries.includes(e)) this.renderer.forget(e.garment);
    this.job = null;
    this.emit('keyframe', { count: this.bank.size, seconds, reason, engine, coverage: res.coverage });
    return entry;
  }

  async makeFirstKeyframe() {
    this.setPhase('generating');
    try { await this.captureKeyframe('first'); if (this.bank.size) this.setPhase('live'); else if (this.phase === 'generating') this.setPhase('idle'); }
    catch (error) {
      this.job = null;
      if (error && error.name === 'AbortError') return;
      this.emit('error', { message: error.message || String(error), stage: 'first' });
      this.garmentBlob = null; this.setPhase('idle');   // no automatic retries: the user drops the garment again
    }
  }

  // ---------- background angles ----------
  isStill(now) {
    const pv = FreeBank.poseVector(this.landmarks); if (!pv) { this.stillRef = null; return false; }
    if (!this.stillRef || FreeBank.poseDistance(pv, this.stillRef.pose) > 0.04) { this.stillRef = { pose: pv, ts: now }; return false; }
    return now - this.stillRef.ts >= 600;
  }
  maybeAddAngle(now) {
    if (!this.options.autoAngles || this.job || now < this.angleCooldownUntil || !this.landmarks) return;
    if (!this.bank.wantsNewKeyframe(this.landmarks) || !this.isStill(now)) return;
    this.captureKeyframe('angle').catch((error) => {
      this.job = null; this.angleCooldownUntil = performance.now() + 15000;
      if (!(error && error.name === 'AbortError')) this.emit('error', { message: error.message || String(error), stage: 'angle' });
    });
  }

  // ---------- per frame ----------
  async update() {
    const v = this.video; if (!v.videoWidth) return;
    const now = performance.now(); this.frame++;
    const W = v.videoWidth, H = v.videoHeight;
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
    if (!this.renderer) this.renderer = FreeRenderer.createMeshRenderer(W, H, { forceFallback: this.options.forceFallbackRenderer });
    this.renderer.resize(W, H);
    if (this.detector && this.detector.ready) { const r = await this.detector.detect(v); this.landmarks = r.landmarks || null; }
    if (this.segmenter && this.segmenter.ready && this.frame % 3 === 0) this.segmenter.segment(v);
    if (this.segmenter && this.segmenter.hasMask && this.frame % 8 === 0) { const c = this.segmenter.skinColor(); if (c) this.liveSkin = c; }
    if (this.phase === 'countdown' && this.garmentBlob) this.handleCountdown(now);
    else if (this.phase === 'live') this.maybeAddAngle(now);
    this.render();
  }

  handleCountdown(now) {
    if (!this.shouldersVisible()) { this.countdownEnd = null; if (this.lastCount !== 'hint') { this.lastCount = 'hint'; this.emit('countdown', { n: null, hint: 'Step back so I can see your shoulders' }); } return; }
    if (this.countdownEnd === null) this.countdownEnd = now + this.options.countdown * 1000;
    const left = Math.max(0, Math.ceil((this.countdownEnd - now) / 1000));
    if (left !== this.lastCount) { this.lastCount = left; this.emit('countdown', { n: left }); }
    if (now >= this.countdownEnd) { this.countdownEnd = null; this.makeFirstKeyframe(); }
  }

  ensureCurGray() {
    if (this.curGrayFrame === this.frame) return this.curGray;
    const W = this.video.videoWidth, H = this.video.videoHeight, wh = Math.round(H * FREE_WORK_W / W);
    if (this.work.height !== wh) this.work.height = wh;
    this.workCtx.drawImage(this.video, 0, 0, FREE_WORK_W, wh);
    this.curGray = FreeFlow.toGray(this.workCtx.getImageData(0, 0, FREE_WORK_W, wh)); this.curGrayFrame = this.frame; return this.curGray;
  }

  updateGain(entry) {
    let target = [1, 1, 1];
    if (entry.refLight && this.liveSkin) target = this.liveSkin.map((c, i) => clampN(c / Math.max(1, entry.refLight[i]), 0.7, 1.4));
    for (let i = 0; i < 3; i++) this.gain[i] += (target[i] - this.gain[i]) * 0.1;
  }

  // Warp one keyframe's garment onto the current pose and draw it. Returns the bounding box drawn.
  drawEntry(entry, weight, primary) {
    const W = this.canvas.width, H = this.canvas.height;
    const { src, dst } = FreeMLS.controlPairs(entry.landmarks, this.landmarks, W, H);
    if (src.length < 2) return null;
    const n = FREE_COLS * FREE_ROWS, mult = primary && this.options.tracking ? new Float32Array(n * 2) : null;
    let pos = FreeMLS.mlsSimilarity(src, dst, entry.grid.pos, 1.0, mult);
    if (mult) {
      const s = FREE_WORK_W / W, srcW = new Float32Array(n * 2), dstW = new Float32Array(n * 2);
      for (let i = 0; i < n * 2; i++) { srcW[i] = entry.grid.pos[i] * s; dstW[i] = pos[i] * s; }
      const { disp } = entry.refiner.refine(this.ensureCurGray(), srcW, dstW, FREE_COLS, FREE_ROWS, mult, entry.active);
      const out = new Float32Array(n * 2); for (let i = 0; i < n * 2; i++) out[i] = pos[i] + disp[i] / s; pos = out;
    }
    if (primary) this.updateGain(entry);
    this.renderer.drawLayer({ texture: entry.garment, positions: pos, uv: entry.grid.uv, indices: this.indices, alpha: weight, gain: this.gain });
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (let i = 0; i < pos.length; i += 2) { if (pos[i] < x0) x0 = pos[i]; if (pos[i] > x1) x1 = pos[i]; if (pos[i + 1] < y0) y0 = pos[i + 1]; if (pos[i + 1] > y1) y1 = pos[i + 1]; }
    return { x0, y0, x1, y1 };
  }

  render() {
    const ctx = this.ctx, W = this.canvas.width, H = this.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, W, H);
    const target = this.phase === 'live' && this.bank.size && this.landmarks ? 1 : (this.phase === 'generating' && this.bank.size ? 1 : 0);
    this.fade += (target - this.fade) * 0.2;
    if (this.fade < 0.02 || !this.landmarks || !this.bank.size) return;
    const t0 = performance.now();
    this.renderer.begin();
    let box = null;
    const selection = this.bank.select(this.landmarks);
    selection.forEach((s, i) => {
      const b = this.drawEntry(s.entry, s.weight * this.fade, i === 0);
      if (b) box = box ? { x0: Math.min(box.x0, b.x0), y0: Math.min(box.y0, b.y0), x1: Math.max(box.x1, b.x1), y1: Math.max(box.y1, b.y1) } : b;
    });
    if (!box) return;
    ctx.drawImage(this.renderer.canvas, 0, 0);
    if (this.segmenter && this.segmenter.hasMask) this.drawOcclusion(box);
    this.stats.renderMs += (performance.now() - t0 - this.stats.renderMs) * 0.1;
  }

  // Your head, hair and arms/hands (from the live camera image) are drawn back on top of the garment.
  drawOcclusion(box) {
    const v = this.video, mask = this.segmenter.maskCanvas, W = this.canvas.width, H = this.canvas.height;
    if (this.skin.width !== W || this.skin.height !== H) { this.skin.width = W; this.skin.height = H; }
    const bx = clampN(Math.floor(box.x0) - 4, 0, W - 1), by = clampN(Math.floor(box.y0) - 4, 0, H - 1);
    const bw = clampN(Math.ceil(box.x1 - box.x0) + 8, 1, W - bx), bh = clampN(Math.ceil(box.y1 - box.y0) + 8, 1, H - by);
    const sc = this.skinCtx; sc.setTransform(1, 0, 0, 1, 0, 0); sc.globalCompositeOperation = 'source-over'; sc.clearRect(bx, by, bw, bh);
    const vx = v.videoWidth / W, vy = v.videoHeight / H;
    sc.drawImage(v, bx * vx, by * vy, bw * vx, bh * vy, bx, by, bw, bh);
    sc.globalCompositeOperation = 'destination-in'; sc.imageSmoothingEnabled = true; sc.filter = 'blur(1.5px)';
    const mx = mask.width / W, my = mask.height / H;
    sc.drawImage(mask, bx * mx, by * my, bw * mx, bh * my, bx, by, bw, bh); sc.filter = 'none'; sc.globalCompositeOperation = 'source-over';
    this.ctx.save(); this.ctx.globalAlpha = Math.min(1, this.fade); this.ctx.drawImage(this.skin, bx, by, bw, bh, bx, by, bw, bh); this.ctx.restore();
  }
}

if (typeof window !== 'undefined') window.FreePipeline = FreePipeline;
if (typeof module !== 'undefined') module.exports = { portraitCrop };
