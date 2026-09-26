// Moving Least Squares image deformation (Schaefer, McPhail & Warren, SIGGRAPH 2006), similarity variant.
// Given control points in the keyframe (src) and where they are now (dst), every other point is moved by the
// similarity transform (rotation + uniform scale + translation) that best fits the *nearby* control points.
// Closed form with complex numbers: cheap enough to run per frame for a few hundred mesh vertices.
//
// Points are {x, y}. `points` is a flat Float32Array [x0, y0, x1, y1, ...]. Returns a new flat array.
function mlsSimilarity(src, dst, points, alpha = 1.0, outMult = null) {
  const n = Math.min(src.length, dst.length);
  const out = new Float32Array(points.length);
  if (n === 0) { out.set(points); if (outMult) for (let k = 0; k < points.length; k += 2) { outMult[k] = 1; outMult[k + 1] = 0; } return out; }
  for (let k = 0; k < points.length; k += 2) {
    const vx = points[k], vy = points[k + 1];
    // weights w_i = 1 / |p_i - v|^(2 alpha); a vertex sitting on a control point maps exactly to its target
    let sw = 0, px = 0, py = 0, qx = 0, qy = 0, exact = -1;
    const w = new Array(n);
    for (let i = 0; i < n; i++) {
      const dx = src[i].x - vx, dy = src[i].y - vy; const d2 = dx * dx + dy * dy;
      if (d2 < 1e-9) { exact = i; break; }
      w[i] = 1 / Math.pow(d2, alpha);
      sw += w[i]; px += w[i] * src[i].x; py += w[i] * src[i].y; qx += w[i] * dst[i].x; qy += w[i] * dst[i].y;
    }
    if (exact >= 0) { out[k] = dst[exact].x; out[k + 1] = dst[exact].y; if (outMult) { outMult[k] = 1; outMult[k + 1] = 0; } continue; }
    px /= sw; py /= sw; qx /= sw; qy /= sw;
    // c = sum w_i * (q^_i * conj(p^_i)) / sum w_i * |p^_i|^2   (complex multiplier = rotation * scale)
    let numRe = 0, numIm = 0, den = 0;
    for (let i = 0; i < n; i++) {
      const ax = src[i].x - px, ay = src[i].y - py, bx = dst[i].x - qx, by = dst[i].y - qy;
      numRe += w[i] * (bx * ax + by * ay); numIm += w[i] * (by * ax - bx * ay); den += w[i] * (ax * ax + ay * ay);
    }
    const ux = vx - px, uy = vy - py;
    if (den < 1e-9 || n === 1) { out[k] = vx + (qx - px); out[k + 1] = vy + (qy - py); if (outMult) { outMult[k] = 1; outMult[k + 1] = 0; } continue; } // translation only
    const cRe = numRe / den, cIm = numIm / den;
    out[k] = cRe * ux - cIm * uy + qx; out[k + 1] = cRe * uy + cIm * ux + qy;
    if (outMult) { outMult[k] = cRe; outMult[k + 1] = cIm; }
  }
  return out;
}

// The landmarks that drive the garment: shoulders, elbows, wrists, hips (MediaPipe Pose indices).
const CONTROL_LANDMARKS = [11, 12, 13, 14, 15, 16, 23, 24];

// Control point pairs between the landmarks seen when the keyframe was taken and the current ones (both normalised
// 0..1), in pixels of a frame w x h. Only landmarks that are reliably visible in BOTH are used.
function controlPairs(refLandmarks, curLandmarks, w, h, minVisibility = 0.5, indices = CONTROL_LANDMARKS) {
  const src = [], dst = [];
  for (const i of indices) {
    const a = refLandmarks && refLandmarks[i], b = curLandmarks && curLandmarks[i];
    if (!a || !b) continue;
    const va = a.visibility === undefined ? 1 : a.visibility, vb = b.visibility === undefined ? 1 : b.visibility;
    if (va < minVisibility || vb < minVisibility) continue;
    src.push({ x: a.x * w, y: a.y * h }); dst.push({ x: b.x * w, y: b.y * h });
  }
  return { src, dst };
}

// Regular grid of (cols x rows) vertices over a rectangle, plus texture coordinates (0..1) for each.
function makeGrid(bbox, cols, rows) {
  const pos = new Float32Array(cols * rows * 2), uv = new Float32Array(cols * rows * 2);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const u = i / (cols - 1), v = j / (rows - 1); const k = (j * cols + i) * 2;
      pos[k] = bbox.x + u * bbox.w; pos[k + 1] = bbox.y + v * bbox.h; uv[k] = u; uv[k + 1] = v;
    }
  }
  return { pos, uv, cols, rows };
}

if (typeof window !== 'undefined') window.FreeMLS = { mlsSimilarity, controlPairs, makeGrid, CONTROL_LANDMARKS };
if (typeof module !== 'undefined') module.exports = { mlsSimilarity, controlPairs, makeGrid, CONTROL_LANDMARKS };
