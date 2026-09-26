// Garment rendering: a flat garment image (uploaded / dropped, or a built-in sample) is warped onto the
// torso with a textured triangle mesh whose corners follow the shoulder and hip landmarks.
const GARMENT_ROWS = 14;
const GARMENT_COLS = 10;
// k: garment width vs shoulder width, kHip: hem width vs hip width, top/bottom: extent in "torso lengths"
// measured from the shoulder line (0) toward the hip line (1), flare: extra hem widening below the hips.
const TYPE_PARAMS = {
  shirt: { k: 1.50, kHip: 1.25, top: -0.14, bottom: 1.05, flare: 0, minBottom: 0.80 },
  hoodie: { k: 1.62, kHip: 1.35, top: -0.30, bottom: 1.12, flare: 0, minBottom: 0.85 },
  jacket: { k: 1.66, kHip: 1.35, top: -0.20, bottom: 1.15, flare: 0, minBottom: 0.85 },
  dress: { k: 1.18, kHip: 1.55, top: -0.12, bottom: 2.10, flare: 0.20, minBottom: 1.0 }
};

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const smooth = (t) => t * t * (3 - 2 * t);
const unit = (x, y) => { const l = Math.hypot(x, y) || 1; return { x: x / l, y: y / l }; };

// ---------- geometry (pure, unit-tested) ----------
// Returns null when the shoulders are not reliably visible.
function computeMeshTargets(lm, w, h, type = 'shirt', opts = {}) {
  const p = TYPE_PARAMS[type] || TYPE_PARAMS.shirt;
  const rows = opts.rows || GARMENT_ROWS, cols = opts.cols || GARMENT_COLS;
  const vis = (i) => (lm && lm[i] ? (lm[i].visibility === undefined ? 1 : lm[i].visibility) : 0);
  if (vis(11) < 0.4 || vis(12) < 0.4) return null;
  const P = (i) => ({ x: lm[i].x * w, y: lm[i].y * h });
  let A = P(11), B = P(12); if (A.x > B.x) [A, B] = [B, A];
  const sw = Math.hypot(B.x - A.x, B.y - A.y);
  if (sw < 6) return null;
  const sm = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
  const ax = unit(B.x - A.x, B.y - A.y);
  let hm, hipW, hax;
  if (vis(23) >= 0.4 && vis(24) >= 0.4) {
    let HA = P(23), HB = P(24); if (HA.x > HB.x) [HA, HB] = [HB, HA];
    hm = { x: (HA.x + HB.x) / 2, y: (HA.y + HB.y) / 2 };
    hipW = Math.hypot(HB.x - HA.x, HB.y - HA.y); hax = unit(HB.x - HA.x, HB.y - HA.y);
  } else { // hips off-screen: assume an upright torso
    hm = { x: sm.x - ax.y * sw * 1.4, y: sm.y + ax.x * sw * 1.4 }; hipW = sw * 0.8; hax = ax;
  }
  const tx = hm.x - sm.x, ty = hm.y - sm.y; const L = Math.hypot(tx, ty);
  if (L < 6) return null;
  const userScale = opts.userScale || 1;
  const hwTop = sw * 0.5 * p.k * userScale;
  const hwBot = Math.max(hipW * 0.5 * p.kHip * userScale, hwTop * p.minBottom);
  const rangeRows = p.bottom - p.top;
  const aspectRows = opts.texAspect ? (2 * hwTop * opts.texAspect) / L : rangeRows;
  const tTop = p.top, tBot = p.top + lerp(rangeRows, aspectRows, opts.texAspect ? 0.5 : 0) * userScale;
  const ox = (opts.offsetX || 0), oy = (opts.offsetY || 0);
  const targets = new Float32Array(rows * cols * 2), weights = new Float32Array(rows * cols);
  for (let i = 0; i < rows; i++) {
    const t = tTop + (tBot - tTop) * (i / (rows - 1));
    const tc = clamp(t, 0, 1);
    const cx = sm.x + tx * t + ox, cy = sm.y + ty * t + oy;
    const u = unit(lerp(ax.x, hax.x, tc), lerp(ax.y, hax.y, tc));
    let hw;
    if (t < 0) hw = hwTop * (1 + t * 0.30);
    else if (t <= 1) hw = lerp(hwTop, hwBot, smooth(t));
    else hw = hwBot + (t - 1) * p.flare * sw;
    const wgt = clamp((t - 0.05) / 0.9, 0, 1);
    for (let j = 0; j < cols; j++) {
      const s = -1 + 2 * (j / (cols - 1)); const v = i * cols + j;
      targets[v * 2] = cx + u.x * hw * s; targets[v * 2 + 1] = cy + u.y * hw * s;
      weights[v] = wgt;
    }
  }
  return { targets, weights, scale: sw, torso: L, shoulderMid: sm, hipMid: hm, rows, cols };
}

// Affine transform mapping triangle (x,y)*3 to (u,v)*3 -> canvas [a,b,c,d,e,f].
function solveAffine(x0, y0, x1, y1, x2, y2, u0, v0, u1, v1, u2, v2) {
  const det = x0 * (y1 - y2) + x1 * (y2 - y0) + x2 * (y0 - y1);
  if (Math.abs(det) < 1e-9) return null;
  const a = (u0 * (y1 - y2) + u1 * (y2 - y0) + u2 * (y0 - y1)) / det;
  const c = (x0 * (u1 - u2) + x1 * (u2 - u0) + x2 * (u0 - u1)) / det;
  const e = (u0 * (x1 * y2 - x2 * y1) + u1 * (x2 * y0 - x0 * y2) + u2 * (x0 * y1 - x1 * y0)) / det;
  const b = (v0 * (y1 - y2) + v1 * (y2 - y0) + v2 * (y0 - y1)) / det;
  const d = (x0 * (v1 - v2) + x1 * (v2 - v0) + x2 * (v0 - v1)) / det;
  const f = (v0 * (x1 * y2 - x2 * y1) + v1 * (x2 * y0 - x0 * y2) + v2 * (x0 * y1 - x1 * y0)) / det;
  return [a, b, c, d, e, f];
}

// Draws `tex` warped onto the mesh vertices `pos` (rows*cols*2).
function drawTexturedMesh(ctx, tex, pos, rows, cols) {
  const tw = tex.width, th = tex.height;
  const tri = (sx0, sy0, sx1, sy1, sx2, sy2, i0, i1, i2) => {
    let x0 = pos[i0 * 2], y0 = pos[i0 * 2 + 1], x1 = pos[i1 * 2], y1 = pos[i1 * 2 + 1], x2 = pos[i2 * 2], y2 = pos[i2 * 2 + 1];
    const m = solveAffine(sx0, sy0, sx1, sy1, sx2, sy2, x0, y0, x1, y1, x2, y2); if (!m) return;
    const cx = (x0 + x1 + x2) / 3, cy = (y0 + y1 + y2) / 3, g = 0.7; // grow slightly to hide seams
    const grow = (x, y) => { const d = Math.hypot(x - cx, y - cy) || 1; return [x + (x - cx) / d * g, y + (y - cy) / d * g]; };
    ctx.save(); ctx.beginPath();
    let q = grow(x0, y0); ctx.moveTo(q[0], q[1]); q = grow(x1, y1); ctx.lineTo(q[0], q[1]); q = grow(x2, y2); ctx.lineTo(q[0], q[1]);
    ctx.closePath(); ctx.clip(); ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]); ctx.drawImage(tex, 0, 0); ctx.restore();
  };
  for (let i = 0; i < rows - 1; i++) {
    for (let j = 0; j < cols - 1; j++) {
      const u0 = (j / (cols - 1)) * tw, u1 = ((j + 1) / (cols - 1)) * tw, v0 = (i / (rows - 1)) * th, v1 = ((i + 1) / (rows - 1)) * th;
      const a = i * cols + j, b = a + 1, c = a + cols, d = c + 1;
      tri(u0, v0, u1, v0, u0, v1, a, b, c);
      tri(u1, v0, u1, v1, u0, v1, b, d, c);
    }
  }
}

// ---------- garment image preparation ----------
// Removes a plain background (flood fill from the border) when the image has no transparency,
// then crops to the garment. Works well for product photos on white/plain backgrounds.
function prepareGarmentTexture(source, maxSize = 1024) {
  const sw = source.naturalWidth || source.videoWidth || source.width, sh = source.naturalHeight || source.videoHeight || source.height;
  const s = Math.min(1, maxSize / Math.max(sw, sh));
  const W = Math.max(1, Math.round(sw * s)), H = Math.max(1, Math.round(sh * s));
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true }); ctx.drawImage(source, 0, 0, W, H);
  const img = ctx.getImageData(0, 0, W, H); const d = img.data;
  let transparent = 0; for (let i = 3; i < d.length; i += 4) if (d[i] < 250) transparent++;
  if (transparent / (W * H) < 0.02) {
    const px = (x, y) => (y * W + x) * 4;
    const corners = [px(0, 0), px(W - 1, 0), px(0, H - 1), px(W - 1, H - 1)];
    const bg = [0, 1, 2].map((c) => corners.reduce((a, o) => a + d[o + c], 0) / 4);
    const dist = (o) => Math.hypot(d[o] - bg[0], d[o + 1] - bg[1], d[o + 2] - bg[2]);
    const seen = new Uint8Array(W * H); const stack = new Int32Array(W * H); let sp = 0;
    const push = (x, y) => { const k = y * W + x; if (seen[k] || dist(k * 4) > 58) return; seen[k] = 1; stack[sp++] = k; };
    for (let x = 0; x < W; x++) { push(x, 0); push(x, H - 1); }
    for (let y = 0; y < H; y++) { push(0, y); push(W - 1, y); }
    while (sp) {
      const k = stack[--sp]; const x = k % W, y = (k / W) | 0;
      if (x > 0) push(x - 1, y); if (x < W - 1) push(x + 1, y); if (y > 0) push(x, y - 1); if (y < H - 1) push(x, y + 1);
    }
    for (let k = 0; k < W * H; k++) if (seen[k]) d[k * 4 + 3] = 0;
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) { // soften the cut-out edge
      const k = y * W + x; if (seen[k]) continue;
      if (seen[k - 1] || seen[k + 1] || seen[k - W] || seen[k + W]) d[k * 4 + 3] = 150;
    }
    ctx.putImageData(img, 0, 0);
  }
  let minX = W, minY = H, maxX = -1, maxY = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (d[(y * W + x) * 4 + 3] > 20) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  if (maxX < 0) return canvas;
  const pad = 2; minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad); maxX = Math.min(W - 1, maxX + pad); maxY = Math.min(H - 1, maxY + pad);
  const out = document.createElement('canvas'); out.width = maxX - minX + 1; out.height = maxY - minY + 1;
  out.getContext('2d').drawImage(canvas, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

// ---------- built-in sample garments (drawn procedurally, transparent background) ----------
function makeSampleGarment(type) {
  const c = document.createElement('canvas'); const shade = (ctx, w, h, base, hi, lo) => {
    const g = ctx.createLinearGradient(0, 0, w, 0); g.addColorStop(0, lo); g.addColorStop(0.35, hi); g.addColorStop(0.7, base); g.addColorStop(1, lo); return g;
  };
  const sizes = { shirt: [400, 440], hoodie: [420, 540], jacket: [420, 520], dress: [300, 700] }; const [W, H] = sizes[type] || sizes.shirt;
  c.width = W; c.height = H; const ctx = c.getContext('2d'); ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  const seam = (draw) => { ctx.save(); ctx.strokeStyle = 'rgba(0,0,0,.28)'; ctx.lineWidth = 2; ctx.setLineDash([6, 5]); ctx.beginPath(); draw(); ctx.stroke(); ctx.restore(); };
  const sheen = () => { const g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, 'rgba(255,255,255,.16)'); g.addColorStop(0.5, 'rgba(255,255,255,0)'); g.addColorStop(1, 'rgba(0,0,0,.22)'); ctx.fillStyle = g; ctx.fill(); };
  if (type === 'shirt') {
    ctx.beginPath(); ctx.moveTo(135, 40); ctx.lineTo(45, 68); ctx.lineTo(0, 190); ctx.lineTo(70, 218); ctx.lineTo(96, 150); ctx.lineTo(92, 425);
    ctx.quadraticCurveTo(200, 445, 308, 425); ctx.lineTo(304, 150); ctx.lineTo(330, 218); ctx.lineTo(400, 190); ctx.lineTo(355, 68); ctx.lineTo(265, 40);
    ctx.quadraticCurveTo(200, 108, 135, 40); ctx.closePath(); ctx.fillStyle = shade(ctx, W, H, '#f97316', '#fb923c', '#c2410c'); ctx.fill(); sheen();
    ctx.strokeStyle = '#9a3412'; ctx.lineWidth = 9; ctx.beginPath(); ctx.moveTo(135, 40); ctx.quadraticCurveTo(200, 108, 265, 40); ctx.stroke();
    seam(() => { ctx.moveTo(96, 150); ctx.lineTo(70, 218); ctx.moveTo(304, 150); ctx.lineTo(330, 218); ctx.moveTo(96, 420); ctx.quadraticCurveTo(200, 438, 304, 420); });
  } else if (type === 'hoodie') {
    ctx.beginPath(); ctx.moveTo(120, 100); ctx.quadraticCurveTo(110, 5, 210, 5); ctx.quadraticCurveTo(310, 5, 300, 100); ctx.lineTo(330, 110); ctx.lineTo(420, 380); ctx.lineTo(350, 400);
    ctx.lineTo(318, 210); ctx.lineTo(322, 520); ctx.quadraticCurveTo(210, 540, 98, 520); ctx.lineTo(102, 210); ctx.lineTo(70, 400); ctx.lineTo(0, 380); ctx.lineTo(90, 110); ctx.closePath();
    ctx.fillStyle = shade(ctx, W, H, '#7c3aed', '#8b5cf6', '#4c1d95'); ctx.fill(); sheen();
    ctx.fillStyle = '#2e1065'; ctx.beginPath(); ctx.moveTo(150, 100); ctx.quadraticCurveTo(140, 30, 210, 30); ctx.quadraticCurveTo(280, 30, 270, 100); ctx.quadraticCurveTo(210, 160, 150, 100); ctx.fill();
    ctx.strokeStyle = '#ddd6fe'; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(185, 128); ctx.lineTo(180, 210); ctx.moveTo(235, 128); ctx.lineTo(240, 210); ctx.stroke();
    ctx.fillStyle = 'rgba(0,0,0,.18)'; ctx.beginPath(); ctx.moveTo(140, 360); ctx.lineTo(280, 360); ctx.lineTo(300, 470); ctx.lineTo(120, 470); ctx.closePath(); ctx.fill();
    seam(() => { ctx.moveTo(102, 210); ctx.lineTo(70, 400); ctx.moveTo(318, 210); ctx.lineTo(350, 400); ctx.moveTo(100, 500); ctx.quadraticCurveTo(210, 520, 320, 500); });
  } else if (type === 'jacket') {
    ctx.beginPath(); ctx.moveTo(130, 30); ctx.lineTo(50, 62); ctx.lineTo(0, 420); ctx.lineTo(72, 430); ctx.lineTo(100, 190); ctx.lineTo(96, 505); ctx.lineTo(324, 505); ctx.lineTo(320, 190);
    ctx.lineTo(348, 430); ctx.lineTo(420, 420); ctx.lineTo(370, 62); ctx.lineTo(290, 30); ctx.lineTo(210, 130); ctx.closePath();
    ctx.fillStyle = shade(ctx, W, H, '#16a34a', '#22c55e', '#14532d'); ctx.fill(); sheen();
    ctx.fillStyle = '#14532d'; ctx.beginPath(); ctx.moveTo(130, 30); ctx.lineTo(210, 130); ctx.lineTo(290, 30); ctx.lineTo(262, 22); ctx.lineTo(210, 78); ctx.lineTo(158, 22); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#d1fae5'; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(210, 130); ctx.lineTo(210, 505); ctx.stroke();
    seam(() => { ctx.moveTo(100, 190); ctx.lineTo(72, 430); ctx.moveTo(320, 190); ctx.lineTo(348, 430); ctx.moveTo(130, 400); ctx.lineTo(190, 400); ctx.moveTo(230, 400); ctx.lineTo(290, 400); });
  } else {
    ctx.beginPath(); ctx.moveTo(100, 10); ctx.lineTo(120, 10); ctx.lineTo(125, 90); ctx.quadraticCurveTo(150, 120, 175, 90); ctx.lineTo(180, 10); ctx.lineTo(200, 10); ctx.lineTo(215, 110);
    ctx.lineTo(205, 250); ctx.lineTo(300, 690); ctx.quadraticCurveTo(150, 710, 0, 690); ctx.lineTo(95, 250); ctx.lineTo(85, 110); ctx.closePath();
    ctx.fillStyle = shade(ctx, W, H, '#ec4899', '#f472b6', '#9d174d'); ctx.fill(); sheen();
    ctx.strokeStyle = '#831843'; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(95, 250); ctx.quadraticCurveTo(150, 268, 205, 250); ctx.stroke();
    seam(() => { ctx.moveTo(150, 270); ctx.lineTo(150, 690); ctx.moveTo(110, 270); ctx.lineTo(60, 690); ctx.moveTo(190, 270); ctx.lineTo(240, 690); });
  }
  return c;
}

class GarmentOverlay {
  constructor(canvas, options = {}) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.garmentType = options.garmentType || 'hoodie';
    this.motion = 0.55; this.brightness = 0.5; this.pose = null; this.alpha = 0; this.lastTime = 0; this.ambient = 1;
    this.userScale = 1; this.userOffsetX = 0; this.userOffsetY = 0; this.frame = 0;
    this.physics = new ClothPhysics(GARMENT_ROWS, GARMENT_COLS);
    this.layer = document.createElement('canvas'); this.layerCtx = this.layer.getContext('2d');
    this.skin = document.createElement('canvas'); this.skinCtx = this.skin.getContext('2d');
    this.probe = document.createElement('canvas'); this.probe.width = this.probe.height = 12; this.probeCtx = this.probe.getContext('2d', { willReadFrequently: true });
    this.customTexture = null; this.texture = makeSampleGarment(this.garmentType);
    this.lastBox = null; this.attachEvents();
  }
  setType(type) { this.garmentType = type; if (!this.customTexture) this.texture = makeSampleGarment(type); this.physics.reset(); }
  useSample(type) { this.customTexture = null; this.garmentType = type; this.texture = makeSampleGarment(type); this.physics.reset(); }
  // Accepts an <img>, ImageBitmap or canvas; strips a plain background and crops it.
  setGarmentImage(source) { this.customTexture = prepareGarmentTexture(source); this.texture = this.customTexture; this.physics.reset(); return this.texture; }
  setMotion(value) { this.motion = clamp(Number(value) / 100, 0, 1); this.physics.setMotion(this.motion); }
  setWind(value) { this.physics.setWind(clamp(Number(value) / 100, 0, 1)); }
  setBrightness(value) { this.brightness = clamp(Number(value) / 100, 0, 1); }
  setSize(value) { this.userScale = clamp(Number(value) / 100, 0.6, 1.6); }
  setPose(landmarks) { this.pose = landmarks; }
  resetAdjust() { this.userOffsetX = this.userOffsetY = 0; this.userScale = 1; }
  syncCanvasSize() { const r = this.canvas.getBoundingClientRect(); this.canvas.width = Math.max(1, Math.round(r.width * devicePixelRatio)); this.canvas.height = Math.max(1, Math.round(r.height * devicePixelRatio)); }
  attachEvents() {
    let start = null;
    this.canvas.addEventListener('pointerdown', (e) => { start = { x: e.clientX, y: e.clientY, ox: this.userOffsetX, oy: this.userOffsetY }; this.canvas.setPointerCapture(e.pointerId); });
    this.canvas.addEventListener('pointermove', (e) => { // manual fine-tuning; the view is mirrored so screen-right is canvas-left
      if (!start) return; const r = this.canvas.getBoundingClientRect(); const k = this.canvas.width / r.width;
      this.userOffsetX = start.ox - (e.clientX - start.x) * k; this.userOffsetY = start.oy + (e.clientY - start.y) * k;
    });
    const end = () => { start = null; }; this.canvas.addEventListener('pointerup', end); this.canvas.addEventListener('pointercancel', end);
  }
  estimateAmbient(video, box) {
    try {
      const vw = video.videoWidth, vh = video.videoHeight; if (!vw) return;
      const x = clamp(box.x, 0, vw - 2), y = clamp(box.y, 0, vh - 2), w = clamp(box.w, 2, vw - x), h = clamp(box.h, 2, vh - y);
      this.probeCtx.drawImage(video, x, y, w, h, 0, 0, 12, 12);
      const d = this.probeCtx.getImageData(0, 0, 12, 12).data; let sum = 0; for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      const lum = sum / (144 * 255); this.ambient += (clamp(0.55 + lum * 0.9, 0.7, 1.25) - this.ambient) * 0.15;
    } catch (error) { /* video not ready */ }
  }
  // opts: { video, skinMask } -- skinMask is a canvas whose alpha marks skin/hair/face pixels.
  render(time, opts = {}) {
    const ctx = this.ctx, w = this.canvas.width, h = this.canvas.height;
    const dt = this.lastTime ? (time - this.lastTime) / 1000 : 1 / 30; this.lastTime = time; this.frame++;
    if (this.layer.width !== w || this.layer.height !== h) { this.layer.width = w; this.layer.height = h; this.skin.width = w; this.skin.height = h; }
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, w, h);
    const mesh = this.pose ? computeMeshTargets(this.pose, w, h, this.garmentType, {
      userScale: this.userScale, offsetX: this.userOffsetX, offsetY: this.userOffsetY, texAspect: this.texture.height / this.texture.width }) : null;
    this.alpha += ((mesh ? 1 : 0) - this.alpha) * 0.25;
    if (!mesh) { if (this.alpha < 0.03) { this.physics.reset(); this.alpha = 0; this.lastBox = null; return null; } }
    if (mesh) { this.mesh = mesh; } else if (!this.mesh) { return null; }
    const m = this.mesh; const pos = mesh ? this.physics.step(m.targets, m.weights, m.scale, dt) : this.physics.pos;
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    for (let i = 0; i < pos.length; i += 2) { if (pos[i] < minX) minX = pos[i]; if (pos[i] > maxX) maxX = pos[i]; if (pos[i + 1] < minY) minY = pos[i + 1]; if (pos[i + 1] > maxY) maxY = pos[i + 1]; }
    const box = { x: Math.floor(minX) - 6, y: Math.floor(minY) - 6, w: Math.ceil(maxX - minX) + 12, h: Math.ceil(maxY - minY) + 12 }; this.lastBox = box;
    if (opts.video && this.frame % 8 === 0) this.estimateAmbient(opts.video, { x: m.shoulderMid.x - m.scale * 0.4, y: m.shoulderMid.y, w: m.scale * 0.8, h: m.torso * 0.8 });
    const lc = this.layerCtx; lc.setTransform(1, 0, 0, 1, 0, 0); lc.clearRect(0, 0, w, h);
    lc.filter = `brightness(${((0.5 + this.brightness) * this.ambient).toFixed(3)}) contrast(1.04)`;
    drawTexturedMesh(lc, this.texture, pos, m.rows, m.cols); lc.setTransform(1, 0, 0, 1, 0, 0); lc.filter = 'none';
    ctx.save(); ctx.globalAlpha = this.alpha; ctx.shadowColor = 'rgba(0,0,0,.35)'; ctx.shadowBlur = Math.max(4, m.scale * 0.05); ctx.shadowOffsetY = Math.max(2, m.scale * 0.02);
    ctx.drawImage(this.layer, 0, 0); ctx.restore();
    if (opts.video && opts.skinMask && opts.skinMask.width > 0) this.drawOcclusion(opts.video, opts.skinMask, box);
    return box;
  }
  // Redraws skin/hair/face from the camera image on top of the garment so arms, hands and head stay in front.
  drawOcclusion(video, mask, box) {
    const w = this.canvas.width, h = this.canvas.height;
    const bx = clamp(box.x, 0, w - 1), by = clamp(box.y, 0, h - 1), bw = clamp(box.w, 1, w - bx), bh = clamp(box.h, 1, h - by);
    const sc = this.skinCtx; sc.setTransform(1, 0, 0, 1, 0, 0); sc.globalCompositeOperation = 'source-over'; sc.clearRect(bx, by, bw, bh);
    const vx = video.videoWidth / w, vy = video.videoHeight / h;
    sc.drawImage(video, bx * vx, by * vy, bw * vx, bh * vy, bx, by, bw, bh);
    sc.globalCompositeOperation = 'destination-in'; sc.imageSmoothingEnabled = true; sc.filter = 'blur(1.5px)';
    const mx = mask.width / w, my = mask.height / h;
    sc.drawImage(mask, bx * mx, by * my, bw * mx, bh * my, bx, by, bw, bh); sc.filter = 'none'; sc.globalCompositeOperation = 'source-over';
    this.ctx.save(); this.ctx.globalAlpha = this.alpha; this.ctx.drawImage(this.skin, bx, by, bw, bh, bx, by, bw, bh); this.ctx.restore();
  }
}
const GarmentGeometry = { computeMeshTargets, solveAffine, TYPE_PARAMS, GARMENT_ROWS, GARMENT_COLS };
if (typeof window !== 'undefined') { window.GarmentOverlay = GarmentOverlay; window.GarmentGeometry = GarmentGeometry; }
if (typeof module !== 'undefined') module.exports = { GarmentGeometry, computeMeshTargets, solveAffine };
