class GarmentOverlay {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.garmentType = options.garmentType || 'hoodie';
    this.x = canvas.width * 0.5;
    this.y = canvas.height * 0.58;
    this.scale = 1;
    this.rotation = 0;
    this.dragging = false;
    this.motion = 0.55;
    this.brightness = 0.65;
    this.palette = {
      hoodie: '#7c3aed',
      shirt: '#f97316',
      dress: '#ec4899',
      jacket: '#22c55e'
    };
    this.attachEvents();
  }

  setType(type) {
    this.garmentType = type;
  }

  setMotion(value) {
    this.motion = Number(value) / 100;
  }

  setBrightness(value) {
    this.brightness = Number(value) / 100;
  }

  syncCanvasSize() {
    const rect = this.canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(rect.width * ratio));
    this.canvas.height = Math.max(1, Math.round(rect.height * ratio));
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.scale(ratio, ratio);
  }

  attachEvents() {
    const handlePointerDown = (event) => {
      const rect = this.canvas.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      this.dragging = true;
      this.canvas.classList.add('is-dragging');
      this.dragStart = { x: px, y: py, overlayX: this.x, overlayY: this.y };
    };

    const handlePointerMove = (event) => {
      if (!this.dragging || !this.dragStart) return;
      const rect = this.canvas.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      const dx = px - this.dragStart.x;
      const dy = py - this.dragStart.y;
      this.x = this.dragStart.overlayX + dx;
      this.y = this.dragStart.overlayY + dy;
    };

    const handlePointerUp = () => {
      if (this.dragging) {
        this.dragging = false;
        this.canvas.classList.remove('is-dragging');
      }
      this.dragStart = null;
    };

    this.canvas.addEventListener('pointerdown', handlePointerDown);
    this.canvas.addEventListener('pointermove', handlePointerMove);
    this.canvas.addEventListener('pointerup', handlePointerUp);
    this.canvas.addEventListener('pointerleave', handlePointerUp);
  }

  render(time) {
    const ctx = this.ctx;
    const width = this.canvas.width;
    const height = this.canvas.height;
    const color = this.palette[this.garmentType] || '#7c3aed';
    const bob = Math.sin(time * 2.2) * (10 + this.motion * 24);

    ctx.clearRect(0, 0, width, height);

    const centerX = this.x;
    const centerY = this.y + bob;
    const garmentWidth = Math.min(width * 0.24, 180);
    const garmentHeight = garmentWidth * 1.35;

    ctx.save();
    ctx.translate(centerX, centerY);
    ctx.rotate(this.rotation);
    ctx.filter = `brightness(${1 + this.brightness * 0.8}) contrast(1.1)`;

    // shadow
    ctx.beginPath();
    ctx.ellipse(0, garmentHeight * 0.42, garmentWidth * 0.7, garmentHeight * 0.18, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.fill();

    // garment main body
    ctx.beginPath();
    ctx.moveTo(-garmentWidth * 0.34, -garmentHeight * 0.45);
    ctx.quadraticCurveTo(-garmentWidth * 0.52, -garmentHeight * 0.65, -garmentWidth * 0.42, -garmentHeight * 0.06);
    ctx.lineTo(-garmentWidth * 0.15, garmentHeight * 0.35);
    ctx.quadraticCurveTo(0, garmentHeight * 0.5, garmentWidth * 0.15, garmentHeight * 0.35);
    ctx.lineTo(garmentWidth * 0.42, -garmentHeight * 0.06);
    ctx.quadraticCurveTo(garmentWidth * 0.52, -garmentHeight * 0.65, garmentWidth * 0.34, -garmentHeight * 0.45);
    ctx.closePath();

    const grad = ctx.createLinearGradient(0, -garmentHeight, 0, garmentHeight);
    grad.addColorStop(0, color);
    grad.addColorStop(0.6, color);
    grad.addColorStop(1, this.lighten(color, -18));
    ctx.fillStyle = grad;
    ctx.fill();

    // sleeves
    ctx.beginPath();
    ctx.moveTo(-garmentWidth * 0.42, -garmentHeight * 0.08);
    ctx.lineTo(-garmentWidth * 0.7, -garmentHeight * 0.18);
    ctx.quadraticCurveTo(-garmentWidth * 0.96, 0.04, -garmentWidth * 0.52, garmentHeight * 0.06);
    ctx.lineTo(-garmentWidth * 0.25, garmentHeight * 0.04);
    ctx.closePath();
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(garmentWidth * 0.42, -garmentHeight * 0.08);
    ctx.lineTo(garmentWidth * 0.7, -garmentHeight * 0.18);
    ctx.quadraticCurveTo(garmentWidth * 0.96, 0.04, garmentWidth * 0.52, garmentHeight * 0.06);
    ctx.lineTo(garmentWidth * 0.25, garmentHeight * 0.04);
    ctx.closePath();
    ctx.fill();

    // neckline / detail
    ctx.beginPath();
    ctx.moveTo(-12, -garmentHeight * 0.28);
    ctx.lineTo(0, -garmentHeight * 0.42);
    ctx.lineTo(12, -garmentHeight * 0.28);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.restore();
  }

  lighten(hex, amount) {
    const num = parseInt(hex.replace('#', ''), 16);
    const r = Math.min(255, ((num >> 16) & 255) + amount);
    const g = Math.min(255, ((num >> 8) & 255) + amount);
    const b = Math.min(255, (num & 255) + amount);
    return `rgb(${r}, ${g}, ${b})`;
  }
}

window.GarmentOverlay = GarmentOverlay;
