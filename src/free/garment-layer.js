// Cuts the garment out of the AI keyframe.
// The try-on model repaints only the masked clothing area of the photo we sent, so the keyframe is pixel-aligned
// with that photo. The garment is the "clothes" pixels of the keyframe (multiclass segmentation), optionally
// restricted to what actually changed against the original photo (so trousers are not cut out for a top).
// Pure array code (testable in Node); the canvas helper is at the bottom.

const luma = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

// Box dilation of a 0/255 mask by radius r (separable: nearest set pixel on each side within r).
function dilateMask(mask, w, h, r) {
  if (r <= 0) return mask;
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  const pass = (src, dst, len, count, stride, step) => {
    const next = new Int32Array(len);
    for (let line = 0; line < count; line++) {
      const base = line * stride;
      let ahead = 1e9; for (let i = len - 1; i >= 0; i--) { if (src[base + i * step]) ahead = i; next[i] = ahead; }
      let behind = -1e9; for (let i = 0; i < len; i++) { if (src[base + i * step]) behind = i; dst[base + i * step] = (i - behind <= r || next[i] - i <= r) ? 255 : 0; }
    }
  };
  pass(mask, tmp, w, h, w, 1);   // rows
  pass(tmp, out, h, w, 1, w);    // columns
  return out;
}

// Largest 4-connected component of a 0/255 mask (removes speckles and stray patches).
function largestComponent(mask, w, h) {
  const label = new Int32Array(w * h); const stack = new Int32Array(w * h);
  let best = 0, bestSize = 0, next = 0;
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || label[s]) continue;
    next++; let sp = 0, size = 0; stack[sp++] = s; label[s] = next;
    while (sp) {
      const p = stack[--sp]; size++; const x = p % w, y = (p / w) | 0;
      if (x > 0 && mask[p - 1] && !label[p - 1]) { label[p - 1] = next; stack[sp++] = p - 1; }
      if (x < w - 1 && mask[p + 1] && !label[p + 1]) { label[p + 1] = next; stack[sp++] = p + 1; }
      if (y > 0 && mask[p - w] && !label[p - w]) { label[p - w] = next; stack[sp++] = p - w; }
      if (y < h - 1 && mask[p + w] && !label[p + w]) { label[p + w] = next; stack[sp++] = p + w; }
    }
    if (size > bestSize) { bestSize = size; best = next; }
  }
  const out = new Uint8Array(w * h); if (best) for (let i = 0; i < w * h; i++) if (label[i] === best) out[i] = 255;
  return { mask: out, area: bestSize };
}

// Erosion = dilation of the inverse.
function erodeMask(mask, w, h, r) {
  if (r <= 0) return mask;
  const inv = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) inv[i] = mask[i] ? 0 : 255;
  const d = dilateMask(inv, w, h, r); const out = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) out[i] = d[i] ? 0 : 255; return out;
}

// Fill holes: background pixels not connected to the image border become part of the mask.
function fillHoles(mask, w, h) {
  const seen = new Uint8Array(w * h), stack = new Int32Array(w * h); let sp = 0;
  const push = (p) => { if (!mask[p] && !seen[p]) { seen[p] = 1; stack[sp++] = p; } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); } for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (sp) {
    const p = stack[--sp], x = p % w, y = (p / w) | 0;
    if (x > 0) push(p - 1); if (x < w - 1) push(p + 1); if (y > 0) push(p - w); if (y < h - 1) push(p + w);
  }
  const out = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) out[i] = mask[i] || !seen[i] ? 255 : 0; return out;
}

// key / person: {data: Uint8ClampedArray RGBA, width, height} (same size; person optional).
// cats: Uint8Array class ids at catsW x catsH (MediaPipe multiclass selfie: 1 hair, 2 body-skin, 3 face-skin, 4 clothes).
// The class map is coarse and patchy, so it is used as a hint and for exclusions, not as the outline:
//   garment = (pixels the try-on model changed) minus (hair/skin/face), limited to the neighbourhood of the "clothes" class,
//   then closed and hole-filled. If (almost) nothing changed (same colour as your own shirt) it falls back to the clothes class.
function garmentAlpha({ key, person = null, cats, catsW, catsH, clothesClass = 4, skinClasses = [1, 2, 3], diffThreshold = 22, dilate = 2, near = 12, minChangedRatio = 0.25 }) {
  const w = key.width, h = key.height;
  const clothes = new Uint8Array(w * h), skin = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const cy = Math.min(catsH - 1, Math.floor((y * catsH) / h));
    for (let x = 0; x < w; x++) { const c = cats[cy * catsW + Math.min(catsW - 1, Math.floor((x * catsW) / w))]; if (c === clothesClass) clothes[y * w + x] = 255; else if (skinClasses.includes(c)) skin[y * w + x] = 255; }
  }
  let usedDiff = false, alpha = clothes;
  if (person && person.width === w && person.height === h) {
    const changed = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) if (Math.abs(luma(key.data, i * 4) - luma(person.data, i * 4)) > diffThreshold) changed[i] = 255;
    const grown = dilateMask(changed, w, h, dilate);
    const nearClothes = dilateMask(clothes, w, h, near);
    let clothesArea = 0, hit = 0;
    for (let i = 0; i < w * h; i++) if (clothes[i]) { clothesArea++; if (grown[i]) hit++; }
    if (clothesArea > 0 && hit / clothesArea >= minChangedRatio) { // enough of the clothing changed
      alpha = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) alpha[i] = grown[i] && nearClothes[i] && !skin[i] ? 255 : 0; usedDiff = true;
    }
  }
  alpha = fillHoles(erodeMask(dilateMask(alpha, w, h, 3), w, h, 3), w, h); // close small gaps, fill enclosed holes
  const { mask, area } = largestComponent(alpha, w, h);
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  if (maxX < 0) return { alpha: mask, bbox: null, area: 0, coverage: 0, usedDiff };
  const pad = 3; minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad); maxX = Math.min(w - 1, maxX + pad); maxY = Math.min(h - 1, maxY + pad);
  return { alpha: mask, bbox: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }, area, coverage: area / (w * h), usedDiff };
}

// ---- browser helper: RGBA garment canvas (cropped to bbox, softly feathered edge) ----
function makeGarmentCanvas(keyCanvas, result, feather = 1.6) {
  const { alpha, bbox } = result; if (!bbox) return null;
  const w = keyCanvas.width;
  const out = document.createElement('canvas'); out.width = bbox.w; out.height = bbox.h;
  const ctx = out.getContext('2d'); ctx.drawImage(keyCanvas, bbox.x, bbox.y, bbox.w, bbox.h, 0, 0, bbox.w, bbox.h);
  const mask = document.createElement('canvas'); mask.width = bbox.w; mask.height = bbox.h;
  const mctx = mask.getContext('2d'); const img = mctx.createImageData(bbox.w, bbox.h);
  for (let y = 0; y < bbox.h; y++) for (let x = 0; x < bbox.w; x++) { const o = (y * bbox.w + x) * 4; img.data[o] = img.data[o + 1] = img.data[o + 2] = 255; img.data[o + 3] = alpha[(bbox.y + y) * w + (bbox.x + x)]; }
  mctx.putImageData(img, 0, 0);
  const soft = document.createElement('canvas'); soft.width = bbox.w; soft.height = bbox.h;
  const sctx = soft.getContext('2d'); sctx.filter = `blur(${feather}px)`; sctx.drawImage(mask, 0, 0); sctx.filter = 'none';
  ctx.globalCompositeOperation = 'destination-in'; ctx.drawImage(soft, 0, 0); ctx.globalCompositeOperation = 'source-over';
  return out;
}

if (typeof window !== 'undefined') window.FreeGarment = { garmentAlpha, dilateMask, erodeMask, fillHoles, largestComponent, makeGarmentCanvas };
if (typeof module !== 'undefined') module.exports = { garmentAlpha, dilateMask, erodeMask, fillHoles, largestComponent };
