// Test harness for Free mode: serves the repo over http and plays the part of the local try-on server.
// The "AI" is a mock: it paints a striped orange garment onto the person photo it receives (done in a helper browser page,
// so no image library is needed). Fake pose/segmentation objects are injected into the page (see installFakes), so the whole
// pipeline (countdown -> keyframe -> garment cut-out -> live warp -> extra angles) runs without a person, a GPU or ML models.
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json' };

// garment painted by the mock server, as fractions of the 768x1024 person crop
const GARMENT_BOX = { x0: 0.15, y0: 0.30, x1: 0.85, y1: 0.85 };

async function startHarness(helperPage) {
  const state = { delayMs: 0, online: true, failNext: null, requests: [], health: 0 };
  const compose = (personDataUrl, box) => helperPage.evaluate(async ({ u, box }) => {
    const img = new Image(); img.src = u; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const x = c.getContext('2d'); x.drawImage(img, 0, 0);
    const gx = box.x0 * c.width, gy = box.y0 * c.height, gw = (box.x1 - box.x0) * c.width, gh = (box.y1 - box.y0) * c.height;
    x.fillStyle = '#e8590c'; x.fillRect(gx, gy, gw, gh);                       // the "garment"
    x.fillStyle = '#ffd8a8'; for (let i = 0; i < gh; i += 40) x.fillRect(gx, gy + i, gw, 10); // stripes so texture is trackable
    return c.toDataURL('image/png');
  }, { u: personDataUrl, box });

  const server = http.createServer(async (req, res) => {
    const url = req.url.split('?')[0];
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    if (url === '/health') {
      state.health++;
      if (!state.online) { res.writeHead(503, cors); res.end(); return; }
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, engine: 'mock-harness' })); return;
    }
    if (url === '/tryon' && req.method === 'POST') {
      let body = ''; for await (const chunk of req) body += chunk;
      const json = JSON.parse(body); state.requests.push({ category: json.category, personBytes: json.person.length, garmentBytes: json.garment.length, at: Date.now() });
      if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
      if (state.failNext) { const f = state.failNext; state.failNext = null; res.writeHead(f.status, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: f.error })); return; }
      const image = await compose(json.person, GARMENT_BOX);
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify({ image, seconds: state.delayMs / 1000, engine: 'mock-harness' })); return;
    }
    const file = path.join(root, decodeURIComponent(url));
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }); fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, state, close: () => new Promise((r) => server.close(r)) };
}

// Runs in the page before its own scripts: a fake pose detector and segmenter under the test's control.
function installFakes() {
  window.__testPose = null;                           // tests assign an array of 33 landmarks (or null = nobody in view)
  window.__testDetector = { ready: true, async detect() { return { landmarks: window.__testPose }; } };
  window.__testSegmenter = {
    ready: true, hasMask: false, maskCanvas: null, segment() { return false; }, skinColor() { return null; },
    async segmentImage() {                             // class 4 ("clothes") where the mock server paints the garment
      const w = 64, h = 85, cats = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x >= 0.15 * w && x < 0.85 * w && y >= 0.30 * h && y < 0.85 * h) cats[y * w + x] = 4;
      return { cats, width: w, height: h, skinColor: [200, 160, 140] };
    }
  };
  window.__freeOptions = { countdown: 0.4 };
  try { localStorage.setItem('mode', 'free'); } catch (error) { /* ignore */ }
}

// A standing pose in normalised coordinates. o.cx/o.cy: shoulder mid-point, o.sw: shoulder width, o.armsUp: raise the arms.
function makePose(o = {}) {
  const { cx = 0.5, cy = 0.36, sw = 0.2, armsUp = false, scale = 1 } = o;
  const s = sw * scale, lm = Array.from({ length: 33 }, () => ({ x: cx, y: cy, z: 0, visibility: 1 }));
  const put = (i, dx, dy) => { lm[i] = { x: cx + dx * s, y: cy + dy * s, z: 0, visibility: 1 }; };
  put(0, 0, -1.0);                                     // nose
  put(11, 0.5, 0); put(12, -0.5, 0);                   // shoulders
  if (armsUp) { put(13, 0.8, -0.7); put(14, -0.8, -0.7); put(15, 0.9, -1.6); put(16, -0.9, -1.6); }
  else { put(13, 0.62, 0.8); put(14, -0.62, 0.8); put(15, 0.66, 1.6); put(16, -0.66, 1.6); }
  put(23, 0.4, 2.4); put(24, -0.4, 2.4);               // hips
  return lm;
}

module.exports = { startHarness, installFakes, makePose, GARMENT_BOX };
