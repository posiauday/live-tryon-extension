class ClothPhysics {
  constructor(width, height) { this.width = width; this.height = height; this.motion = 0.55; this.wind = 0.3; this.time = 0; }
  setMotion(value) { this.motion = Math.max(0, Math.min(1, Number(value))); }
  setWind(value) { this.wind = Math.max(0, Math.min(1, Number(value))); }
  update(dt = 1 / 60) { this.time += dt; return { sway: Math.sin(this.time * 5) * this.motion * 8 + this.wind * 5 }; }
}
window.ClothPhysics = ClothPhysics;
