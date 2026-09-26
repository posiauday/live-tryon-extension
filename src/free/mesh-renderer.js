// Draws textured triangle meshes (the warped garment layers). WebGL when available (fast, 1000+ triangles at 60 FPS),
// otherwise a Canvas 2D fallback with the same API. Both render into `.canvas`, which the caller draws onto the overlay.
function gridIndices(cols, rows) {
  const idx = new Uint16Array((cols - 1) * (rows - 1) * 6); let k = 0;
  for (let j = 0; j < rows - 1; j++) for (let i = 0; i < cols - 1; i++) {
    const a = j * cols + i, b = a + 1, c = a + cols, d = c + 1;
    idx[k++] = a; idx[k++] = b; idx[k++] = c; idx[k++] = b; idx[k++] = d; idx[k++] = c;
  }
  return idx;
}

const VERT = `attribute vec2 aPos; attribute vec2 aUV; uniform vec2 uRes; varying vec2 vUV;
void main() { vec2 c = aPos / uRes * 2.0 - 1.0; gl_Position = vec4(c.x, -c.y, 0.0, 1.0); vUV = aUV; }`;
const FRAG = `precision mediump float; varying vec2 vUV; uniform sampler2D uTex; uniform vec3 uGain; uniform float uAlpha;
void main() { vec4 c = texture2D(uTex, vUV); gl_FragColor = vec4(min(c.rgb * uGain, vec3(c.a)), c.a) * uAlpha; }`;

class GLMeshRenderer {
  static create(w, h) {
    try { const r = new GLMeshRenderer(w, h); return r.gl ? r : null; } catch (error) { return null; }
  }
  constructor(w, h) {
    this.kind = 'webgl'; this.canvas = document.createElement('canvas'); this.canvas.width = w; this.canvas.height = h;
    const gl = this.canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: true });
    this.gl = gl; if (!gl) return;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, VERT)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FRAG)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    this.prog = p; this.loc = { pos: gl.getAttribLocation(p, 'aPos'), uv: gl.getAttribLocation(p, 'aUV'), res: gl.getUniformLocation(p, 'uRes'), tex: gl.getUniformLocation(p, 'uTex'), gain: gl.getUniformLocation(p, 'uGain'), alpha: gl.getUniformLocation(p, 'uAlpha') };
    this.posBuf = gl.createBuffer(); this.uvBuf = gl.createBuffer(); this.idxBuf = gl.createBuffer(); this.textures = new Map();
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }
  resize(w, h) { if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; } }
  begin() { const gl = this.gl; gl.viewport(0, 0, this.canvas.width, this.canvas.height); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
  texture(src) {
    const gl = this.gl; let t = this.textures.get(src);
    if (!t) {
      t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.textures.set(src, t);
    }
    return t;
  }
  forget(src) { const t = this.textures.get(src); if (t) { this.gl.deleteTexture(t); this.textures.delete(src); } }
  // positions/uv: Float32Array (2 per vertex); indices: Uint16Array; gain: [r,g,b]
  drawLayer({ texture, positions, uv, indices, alpha = 1, gain = [1, 1, 1] }) {
    const gl = this.gl; gl.useProgram(this.prog);
    gl.bindTexture(gl.TEXTURE_2D, this.texture(texture)); gl.uniform1i(this.loc.tex, 0);
    gl.uniform2f(this.loc.res, this.canvas.width, this.canvas.height); gl.uniform3f(this.loc.gain, gain[0], gain[1], gain[2]); gl.uniform1f(this.loc.alpha, alpha);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf); gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW); gl.enableVertexAttribArray(this.loc.pos); gl.vertexAttribPointer(this.loc.pos, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuf); gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW); gl.enableVertexAttribArray(this.loc.uv); gl.vertexAttribPointer(this.loc.uv, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idxBuf); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    gl.drawElements(gl.TRIANGLES, indices.length, gl.UNSIGNED_SHORT, 0);
  }
}

// Affine transform that maps a source triangle onto a destination triangle -> canvas [a,b,c,d,e,f]
function solveAffine(x0, y0, x1, y1, x2, y2, u0, v0, u1, v1, u2, v2) {
  const det = x0 * (y1 - y2) + x1 * (y2 - y0) + x2 * (y0 - y1); if (Math.abs(det) < 1e-9) return null;
  const a = (u0 * (y1 - y2) + u1 * (y2 - y0) + u2 * (y0 - y1)) / det, c = (x0 * (u1 - u2) + x1 * (u2 - u0) + x2 * (u0 - u1)) / det;
  const e = (u0 * (x1 * y2 - x2 * y1) + u1 * (x2 * y0 - x0 * y2) + u2 * (x0 * y1 - x1 * y0)) / det;
  const b = (v0 * (y1 - y2) + v1 * (y2 - y0) + v2 * (y0 - y1)) / det, d = (x0 * (v1 - v2) + x1 * (v2 - v0) + x2 * (v0 - v1)) / det;
  const f = (v0 * (x1 * y2 - x2 * y1) + v1 * (x2 * y0 - x0 * y2) + v2 * (x0 * y1 - x1 * y0)) / det;
  return [a, b, c, d, e, f];
}

class Canvas2DMeshRenderer {
  constructor(w, h) { this.kind = '2d'; this.canvas = document.createElement('canvas'); this.canvas.width = w; this.canvas.height = h; this.ctx = this.canvas.getContext('2d'); this.scratch = document.createElement('canvas'); }
  resize(w, h) { if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; } }
  begin() { this.ctx.setTransform(1, 0, 0, 1, 0, 0); this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); }
  forget() {}
  drawLayer({ texture, positions, uv, indices, alpha = 1, gain = [1, 1, 1] }) {
    // tint by gain into a scratch copy of the texture when it is not neutral (cheap approximation of the shader)
    let src = texture; const tw = texture.width, th = texture.height;
    if (Math.abs(gain[0] - 1) + Math.abs(gain[1] - 1) + Math.abs(gain[2] - 1) > 0.03) {
      const s = this.scratch; s.width = tw; s.height = th; const g = s.getContext('2d'); g.clearRect(0, 0, tw, th); g.drawImage(texture, 0, 0);
      const avg = (gain[0] + gain[1] + gain[2]) / 3; g.globalCompositeOperation = avg >= 1 ? 'lighter' : 'source-atop';
      g.fillStyle = avg >= 1 ? `rgba(255,255,255,${Math.min(0.5, avg - 1)})` : `rgba(0,0,0,${Math.min(0.6, 1 - avg)})`; g.fillRect(0, 0, tw, th); g.globalCompositeOperation = 'source-over'; src = s;
    }
    const ctx = this.ctx; ctx.save(); ctx.globalAlpha = alpha;
    for (let t = 0; t < indices.length; t += 3) {
      const i0 = indices[t], i1 = indices[t + 1], i2 = indices[t + 2];
      const m = solveAffine(uv[i0 * 2] * tw, uv[i0 * 2 + 1] * th, uv[i1 * 2] * tw, uv[i1 * 2 + 1] * th, uv[i2 * 2] * tw, uv[i2 * 2 + 1] * th,
        positions[i0 * 2], positions[i0 * 2 + 1], positions[i1 * 2], positions[i1 * 2 + 1], positions[i2 * 2], positions[i2 * 2 + 1]); if (!m) continue;
      const cx = (positions[i0 * 2] + positions[i1 * 2] + positions[i2 * 2]) / 3, cy = (positions[i0 * 2 + 1] + positions[i1 * 2 + 1] + positions[i2 * 2 + 1]) / 3;
      const grow = (i) => { const dx = positions[i * 2] - cx, dy = positions[i * 2 + 1] - cy, l = Math.hypot(dx, dy) || 1; return [positions[i * 2] + dx / l * 0.7, positions[i * 2 + 1] + dy / l * 0.7]; };
      ctx.save(); ctx.beginPath(); let q = grow(i0); ctx.moveTo(q[0], q[1]); q = grow(i1); ctx.lineTo(q[0], q[1]); q = grow(i2); ctx.lineTo(q[0], q[1]); ctx.closePath(); ctx.clip();
      ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]); ctx.drawImage(src, 0, 0); ctx.restore();
    }
    ctx.restore();
  }
}

function createMeshRenderer(w, h, { forceFallback = false } = {}) { return (!forceFallback && GLMeshRenderer.create(w, h)) || new Canvas2DMeshRenderer(w, h); }

if (typeof window !== 'undefined') window.FreeRenderer = { createMeshRenderer, GLMeshRenderer, Canvas2DMeshRenderer, gridIndices, solveAffine };
if (typeof module !== 'undefined') module.exports = { gridIndices, solveAffine };
