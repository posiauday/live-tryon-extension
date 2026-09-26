// Verlet spring cloth on the garment mesh. Every vertex is pulled toward its "rest" target (where the
// body says it should be); rows near the shoulders are pinned, lower rows lag, swing and catch wind.
class ClothPhysics {
  constructor(rows = 14, cols = 10) {
    this.rows = rows; this.cols = cols; this.motion = 0.55; this.wind = 0.3; this.time = 0;
    this.pos = new Float32Array(rows * cols * 2); this.prev = new Float32Array(rows * cols * 2); this.initialized = false;
  }
  setMotion(value) { this.motion = Math.max(0, Math.min(1, Number(value))); }
  setWind(value) { this.wind = Math.max(0, Math.min(1, Number(value))); }
  reset() { this.initialized = false; }
  // targets: Float32Array [x0,y0,x1,y1...]; weights: 0 (pinned) .. 1 (free) per vertex; scale: shoulder width in px.
  step(targets, weights, scale, dt = 1 / 30) {
    const n = this.rows * this.cols; dt = Math.min(dt, 0.1); this.time += dt;
    if (!this.initialized) { this.pos.set(targets); this.prev.set(targets); this.initialized = true; return this.pos; }
    const damping = 0.90 - 0.05 * this.motion;
    const maxDrift = scale * 0.45;
    for (let v = 0; v < n; v++) {
      const w = weights[v]; const ix = v * 2, iy = ix + 1;
      if (w <= 0) { this.pos[ix] = targets[ix]; this.pos[iy] = targets[iy]; this.prev[ix] = targets[ix]; this.prev[iy] = targets[iy]; continue; }
      const row = Math.floor(v / this.cols);
      const k = 0.55 - 0.42 * this.motion * w; // looser (more swing) when Motion is high
      const gust = Math.sin(this.time * 2.1 + row * 0.55) + 0.5 * Math.sin(this.time * 4.3 + row);
      const fx = this.wind * gust * w * scale * 0.012;
      const fy = this.wind * Math.abs(gust) * w * scale * 0.003;
      const vx = (this.pos[ix] - this.prev[ix]) * damping, vy = (this.pos[iy] - this.prev[iy]) * damping;
      let nx = this.pos[ix] + vx + (targets[ix] - this.pos[ix]) * k + fx;
      let ny = this.pos[iy] + vy + (targets[iy] - this.pos[iy]) * k + fy;
      const dx = nx - targets[ix], dy = ny - targets[iy]; const dist = Math.hypot(dx, dy);
      if (dist > maxDrift) { nx = targets[ix] + dx / dist * maxDrift; ny = targets[iy] + dy / dist * maxDrift; }
      this.prev[ix] = this.pos[ix]; this.prev[iy] = this.pos[iy]; this.pos[ix] = nx; this.pos[iy] = ny;
    }
    return this.pos;
  }
}
if (typeof window !== "undefined") window.ClothPhysics = ClothPhysics;
if (typeof module !== 'undefined') module.exports = { ClothPhysics };
