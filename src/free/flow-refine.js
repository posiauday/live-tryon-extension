// Local tracking refinement ("fabric follows the body"). The landmark-driven MLS warp moves the garment as a whole;
// this tracks the *real* texture under each mesh vertex (your actual shirt, skin, folds) from the keyframe photo to
// the live frame with a small Lucas-Kanade solver, and nudges the vertex by the residual motion.
// Flat, textureless areas cannot be tracked, so their confidence is low and they simply keep the MLS position.
// All in grayscale at a reduced "work" resolution. Pure code, testable in Node.

function bilinear(g, x, y) {
  const w = g.w, h = g.h;
  if (x < 0) x = 0; else if (x > w - 1.001) x = w - 1.001;
  if (y < 0) y = 0; else if (y > h - 1.001) y = h - 1.001;
  const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * w + x0, d = g.data;
  return (d[i] * (1 - fx) + d[i + 1] * fx) * (1 - fy) + (d[i + w] * (1 - fx) + d[i + w + 1] * fx) * fy;
}

// ImageData-like {data: RGBA, width, height} -> {data: Float32Array 0..255, w, h}
function toGray(img) {
  const n = img.width * img.height, out = new Float32Array(n), d = img.data;
  for (let i = 0; i < n; i++) out[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  return { data: out, w: img.width, h: img.height };
}

class MeshRefiner {
  constructor({ win = 6, iters = 4, maxDisp = 10, minEig = 25, smoothPasses = 2, temporal = 0.5 } = {}) {
    Object.assign(this, { win, iters, maxDisp, minEig, smoothPasses, temporal });
    this.ref = null; this.prev = null;
  }
  setReference(gray) { this.ref = gray; this.prev = null; }
  reset() { this.prev = null; }

  // srcPts: vertex positions in the REFERENCE image (work px); dstPts: where the warp predicts them in the current image.
  // mult: optional [re, im] per vertex, the local reference->current similarity (from MLS), to compensate scale/rotation.
  // active: optional Uint8Array; only vertices flagged 1 are tracked. Returns {disp, conf} (Float32Arrays).
  refine(cur, srcPts, dstPts, cols, rows, mult = null, active = null) {
    const n = cols * rows, disp = new Float32Array(n * 2), conf = new Float32Array(n);
    if (!this.ref) return { disp, conf };
    const W = this.win, N = (2 * W + 1) * (2 * W + 1);
    const tmpl = new Float32Array(N);
    for (let v = 0; v < n; v++) {
      if (active && !active[v]) continue;
      const rx = srcPts[v * 2], ry = srcPts[v * 2 + 1], cx = dstPts[v * 2], cy = dstPts[v * 2 + 1];
      let mr = 1, mi = 0; if (mult) { mr = mult[v * 2]; mi = mult[v * 2 + 1]; }
      const m2 = mr * mr + mi * mi; if (m2 < 1e-6) continue;
      // template: reference patch sampled at (offset / c) so it corresponds pixel-for-pixel to a live-frame window
      let k = 0, meanT = 0;
      for (let uy = -W; uy <= W; uy++) for (let ux = -W; ux <= W; ux++) {
        const ox = (ux * mr + uy * mi) / m2, oy = (uy * mr - ux * mi) / m2; // u / c
        const t = bilinear(this.ref, rx + ox, ry + oy); tmpl[k++] = t; meanT += t;
      }
      meanT /= N; for (let i = 0; i < N; i++) tmpl[i] -= meanT;
      let dx = 0, dy = 0, lam1 = 0, err = 0;
      for (let it = 0; it < this.iters; it++) {
        let sxx = 0, sxy = 0, syy = 0, bx = 0, by = 0, meanI = 0; k = 0;
        const iv = new Float32Array(N), gx = new Float32Array(N), gy = new Float32Array(N);
        for (let uy = -W; uy <= W; uy++) for (let ux = -W; ux <= W; ux++, k++) {
          const xi = cx + dx + ux, yi = cy + dy + uy;
          iv[k] = bilinear(cur, xi, yi); meanI += iv[k];
          gx[k] = (bilinear(cur, xi + 1, yi) - bilinear(cur, xi - 1, yi)) * 0.5; gy[k] = (bilinear(cur, xi, yi + 1) - bilinear(cur, xi, yi - 1)) * 0.5;
        }
        meanI /= N; err = 0;
        for (let i = 0; i < N; i++) {
          const e = tmpl[i] - (iv[i] - meanI); err += e * e;
          sxx += gx[i] * gx[i]; sxy += gx[i] * gy[i]; syy += gy[i] * gy[i]; bx += gx[i] * e; by += gy[i] * e;
        }
        const lam = 1e-3 * (sxx + syy) + 1e-6, det = (sxx + lam) * (syy + lam) - sxy * sxy;
        if (det < 1e-9) break;
        const ddx = ((syy + lam) * bx - sxy * by) / det, ddy = ((sxx + lam) * by - sxy * bx) / det;
        dx += ddx; dy += ddy;
        const mag = Math.hypot(dx, dy); if (mag > this.maxDisp) { dx *= this.maxDisp / mag; dy *= this.maxDisp / mag; }
        const tr = sxx + syy, disc = Math.sqrt(Math.max(0, tr * tr - 4 * (sxx * syy - sxy * sxy)));
        lam1 = (tr - disc) / 2 / N;
        if (Math.hypot(ddx, ddy) < 0.02) break;
      }
      const rms = Math.sqrt(err / N);
      const c = Math.min(1, lam1 / this.minEig) / (1 + (rms / 40) * (rms / 40)); // textured + well matched => trusted
      disp[v * 2] = dx; disp[v * 2 + 1] = dy; conf[v] = Number.isFinite(c) ? c : 0;
    }
    // normalised-convolution smoothing across the grid: confident neighbours fill in for unconfident vertices
    let d = disp, c = conf;
    for (let pass = 0; pass < this.smoothPasses; pass++) {
      const nd = new Float32Array(n * 2), nc = new Float32Array(n);
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
        let sw = 0, sx = 0, sy = 0, sc = 0, cnt = 0;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          const ii = i + di, jj = j + dj; if (ii < 0 || jj < 0 || ii >= cols || jj >= rows) continue;
          const q = jj * cols + ii, wgt = (di === 0 && dj === 0 ? 2 : 1) * c[q]; sw += wgt; sx += wgt * d[q * 2]; sy += wgt * d[q * 2 + 1]; sc += c[q]; cnt++;
        }
        const p = j * cols + i;
        if (sw > 1e-6) { nd[p * 2] = sx / sw; nd[p * 2 + 1] = sy / sw; }
        nc[p] = Math.min(1, sc / cnt * 1.5) * Math.min(1, sw / 2);
      }
      d = nd; c = nc;
    }
    // temporal smoothing against jitter
    if (this.prev && this.prev.length === d.length) { const t = this.temporal; for (let i = 0; i < d.length; i++) d[i] = t * this.prev[i] + (1 - t) * d[i]; }
    this.prev = Float32Array.from(d);
    // shrink towards zero where we do not trust the estimate
    for (let v = 0; v < n; v++) { d[v * 2] *= c[v]; d[v * 2 + 1] *= c[v]; }
    return { disp: d, conf: c };
  }
}

if (typeof window !== 'undefined') window.FreeFlow = { MeshRefiner, toGray, bilinear };
if (typeof module !== 'undefined') module.exports = { MeshRefiner, toGray, bilinear };
