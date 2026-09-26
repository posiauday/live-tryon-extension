// A small bank of AI keyframes, each taken at a different pose. At runtime the one nearest to your current pose is
// used (two are cross-faded near a boundary), so turning or raising your arms does not need a new 15-45 s AI wait.
// New keyframes are requested in the background when your pose is far from every stored one.
const POSE_INDICES = [0, 11, 12, 13, 14, 15, 16]; // nose, shoulders, elbows, wrists

// Pose as a vector in "shoulder-width" units, relative to the shoulder mid-point: invariant to where you stand and
// how far you are from the camera, but sensitive to lean, arm position and (through the nose) head/torso turn.
function poseVector(lm, minVisibility = 0.5) {
  const l = lm && lm[11], r = lm && lm[12];
  if (!l || !r) return null;
  const sw = Math.hypot(l.x - r.x, l.y - r.y); if (sw < 1e-4) return null;
  const mx = (l.x + r.x) / 2, my = (l.y + r.y) / 2;
  const ok = (p) => p && (p.visibility === undefined || p.visibility >= minVisibility);
  const v = POSE_INDICES.map((i) => (ok(lm[i]) ? { x: (lm[i].x - mx) / sw, y: (lm[i].y - my) / sw } : null));
  // Turn proxies (scale-free): shoulder width vs head height above the shoulders, and vs torso length when the hips are
  // visible. Turning the body narrows the shoulders relative to both; leaning or nodding changes them differently.
  let head = null, torso = null;
  if (ok(lm[0])) { const d = Math.hypot(lm[0].x - mx, lm[0].y - my); if (d > 1e-4) head = sw / d; }
  if (ok(lm[23]) && ok(lm[24])) { const d = Math.hypot((lm[23].x + lm[24].x) / 2 - mx, (lm[23].y + lm[24].y) / 2 - my); if (d > 1e-4) torso = sw / d; }
  return { v, sw, head, torso };
}

// Mean distance (in shoulder widths) over the landmarks visible in both poses. Infinity when not comparable.
function poseDistance(a, b) {
  const A = a && (a.v ? a : poseVector(a)), B = b && (b.v ? b : poseVector(b));
  if (!A || !B) return Infinity;
  let sum = 0, n = 0;
  for (let i = 0; i < A.v.length; i++) { if (A.v[i] && B.v[i]) { sum += Math.hypot(A.v[i].x - B.v[i].x, A.v[i].y - B.v[i].y); n++; } }
  if (n < 3) return Infinity;
  let dist = sum / n;
  // body-turn terms, in log-ratio units (0.5 weight): how the shoulders narrowed relative to head height / torso length
  if (A.head && B.head) dist += 0.5 * Math.abs(Math.log(A.head / B.head));
  if (A.torso && B.torso) dist += 0.5 * Math.abs(Math.log(A.torso / B.torso));
  return dist;
}

class KeyframeBank {
  constructor({ max = 6, newKeyframeDistance = 0.45, sticky = 1.15 } = {}) {
    this.max = max; this.newKeyframeDistance = newKeyframeDistance; this.sticky = sticky;
    this.entries = []; this.primary = -1;
  }
  get size() { return this.entries.length; }
  clear() { this.entries = []; this.primary = -1; }
  // entry: { landmarks, ...anything the renderer needs }
  add(entry) {
    entry.pose = poseVector(entry.landmarks); this.entries.push(entry);
    if (this.entries.length > this.max) this.entries.shift();
    return this.entries.length - 1;
  }
  distances(landmarks) { const cur = poseVector(landmarks); return this.entries.map((e) => poseDistance(cur, e.pose)); }
  nearestDistance(landmarks) { const d = this.distances(landmarks); return d.length ? Math.min(...d) : Infinity; }
  // Should we ask the AI for another keyframe now? (pose far from all stored ones and there is room)
  wantsNewKeyframe(landmarks) { return this.entries.length > 0 && this.entries.length < this.max && this.nearestDistance(landmarks) > this.newKeyframeDistance; }
  // Up to two layers to draw with blend weights that sum to 1. Hysteresis keeps the same primary until another is clearly better.
  select(landmarks) {
    if (!this.entries.length) return [];
    const d = this.distances(landmarks);
    let best = 0; for (let i = 1; i < d.length; i++) if (d[i] < d[best]) best = i;
    if (this.primary < 0 || this.primary >= d.length || d[best] * this.sticky < d[this.primary]) this.primary = best;
    const p = this.primary;
    let second = -1; for (let i = 0; i < d.length; i++) if (i !== p && (second < 0 || d[i] < d[second])) second = i;
    if (second < 0 || !isFinite(d[second]) || !isFinite(d[p])) return [{ index: p, entry: this.entries[p], weight: 1 }];
    // only blend when the second keyframe is nearly as close (within 1.6x): weights fall off with distance
    if (d[second] > d[p] * 1.6 || d[p] < 0.08) return [{ index: p, entry: this.entries[p], weight: 1 }];
    const wp = d[second] / (d[p] + d[second]), ws = 1 - wp;
    return [{ index: p, entry: this.entries[p], weight: wp }, { index: second, entry: this.entries[second], weight: ws }];
  }
}

if (typeof window !== 'undefined') window.FreeBank = { KeyframeBank, poseVector, poseDistance };
if (typeof module !== 'undefined') module.exports = { KeyframeBank, poseVector, poseDistance };
