// Unit tests for the free-mode maths (no browser needed).
const { test, expect } = require('@playwright/test');
const { mlsSimilarity, controlPairs, makeGrid } = require('../src/free/mls.js');
const { KeyframeBank, poseVector, poseDistance } = require('../src/free/keyframe-bank.js');
const { garmentAlpha, largestComponent, dilateMask } = require('../src/free/garment-layer.js');
const { MeshRefiner, toGray, bilinear } = require('../src/free/flow-refine.js');

const close = (a, b, eps = 1e-3) => expect(Math.abs(a - b)).toBeLessThan(eps);

test.describe('MLS deformation', () => {
  const square = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
  test('identity control points leave points unchanged; a control point maps exactly to its target', () => {
    const pts = new Float32Array([10, 20, 50, 50, 90, 70]);
    const out = mlsSimilarity(square, square, pts);
    for (let i = 0; i < pts.length; i++) close(out[i], pts[i]);
    const moved = square.map((p, i) => (i === 2 ? { x: 130, y: 120 } : p));
    const o2 = mlsSimilarity(square, moved, new Float32Array([100, 100]));
    close(o2[0], 130); close(o2[1], 120);
  });
  test('a pure translation moves everything by the same amount', () => {
    const dst = square.map((p) => ({ x: p.x + 30, y: p.y - 12 }));
    const out = mlsSimilarity(square, dst, new Float32Array([33, 71, -50, 200]));
    close(out[0], 63); close(out[1], 59); close(out[2], -20); close(out[3], 188);
  });
  test('uniform scale about the centre and a 90 degree rotation are reproduced', () => {
    const c = { x: 50, y: 50 };
    const scaled = square.map((p) => ({ x: c.x + (p.x - c.x) * 2, y: c.y + (p.y - c.y) * 2 }));
    const o = mlsSimilarity(square, scaled, new Float32Array([70, 50]));
    close(o[0], 90, 1e-2); close(o[1], 50, 1e-2);
    const rot = square.map((p) => ({ x: c.x - (p.y - c.y), y: c.y + (p.x - c.x) })); // +90 degrees
    const r = mlsSimilarity(square, rot, new Float32Array([70, 50]));
    close(r[0], 50, 1e-2); close(r[1], 70, 1e-2);
  });
  test('one control point degrades to a translation; none returns the input', () => {
    const o = mlsSimilarity([{ x: 5, y: 5 }], [{ x: 15, y: 0 }], new Float32Array([40, 40]));
    close(o[0], 50); close(o[1], 35);
    const z = mlsSimilarity([], [], new Float32Array([1, 2])); close(z[0], 1); close(z[1], 2);
  });
  test('controlPairs keeps only landmarks visible in both poses and converts to pixels', () => {
    const mk = (vis) => Array.from({ length: 33 }, (_, i) => ({ x: 0.5, y: 0.5, visibility: vis[i] === undefined ? 1 : vis[i] }));
    const a = mk({}), b = mk({ 13: 0.1, 24: 0.2 });
    a[11] = { x: 0.25, y: 0.5, visibility: 1 };
    const { src, dst } = controlPairs(a, b, 200, 100);
    expect(src.length).toBe(6); // 8 control landmarks minus elbow 13 and hip 24
    expect(src[0]).toEqual({ x: 50, y: 50 }); expect(dst[0]).toEqual({ x: 100, y: 50 });
  });
  test('makeGrid covers the rectangle with matching texture coordinates', () => {
    const g = makeGrid({ x: 10, y: 20, w: 100, h: 50 }, 5, 3);
    expect(g.pos.length).toBe(30);
    expect([g.pos[0], g.pos[1]]).toEqual([10, 20]); expect([g.pos[28], g.pos[29]]).toEqual([110, 70]);
    expect([g.uv[28], g.uv[29]]).toEqual([1, 1]);
  });
});

test.describe('keyframe bank', () => {
  const pose = (o = {}) => {
    const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 1 }));
    lm[0] = { x: 0.5, y: 0.25, visibility: 1 }; lm[11] = { x: 0.6, y: 0.4, visibility: 1 }; lm[12] = { x: 0.4, y: 0.4, visibility: 1 };
    lm[13] = { x: 0.65, y: 0.55, visibility: 1 }; lm[14] = { x: 0.35, y: 0.55, visibility: 1 };
    lm[15] = { x: 0.66, y: 0.7, visibility: 1 }; lm[16] = { x: 0.34, y: 0.7, visibility: 1 };
    return Object.assign(lm, o);
  };
  const shifted = (lm, dx, dy, s) => lm.map((p) => ({ x: 0.5 + (p.x - 0.5) * s + dx, y: 0.4 + (p.y - 0.4) * s + dy, visibility: p.visibility }));
  test('pose distance ignores where you stand and how far away you are, but sees arm and head changes', () => {
    const a = pose();
    close(poseDistance(a, shifted(a, 0.1, -0.05, 0.6)), 0, 1e-6);
    const armsUp = pose({ 15: { x: 0.7, y: 0.2, visibility: 1 }, 16: { x: 0.3, y: 0.2, visibility: 1 } });
    expect(poseDistance(a, armsUp)).toBeGreaterThan(0.2);
    const turned = pose({ 0: { x: 0.56, y: 0.25, visibility: 1 } });
    expect(poseDistance(a, turned)).toBeGreaterThan(0.05);
    // narrower shoulders relative to the torso (body turned) is seen even when the head stays put
    const bodyTurn = pose({ 11: { x: 0.56, y: 0.4, visibility: 1 }, 12: { x: 0.44, y: 0.4, visibility: 1 }, 23: { x: 0.55, y: 0.8, visibility: 1 }, 24: { x: 0.45, y: 0.8, visibility: 1 } });
    const bodyFront = pose({ 23: { x: 0.57, y: 0.8, visibility: 1 }, 24: { x: 0.43, y: 0.8, visibility: 1 } });
    expect(poseDistance(bodyFront, bodyTurn)).toBeGreaterThan(0.1);
    expect(poseDistance(a, pose({ 11: { x: 0.6, y: 0.4, visibility: 0.1 }, 12: { x: 0.4, y: 0.4, visibility: 0.1 } }))).toBeGreaterThanOrEqual(0);
    expect(poseVector(null)).toBeNull();
  });
  test('asks for a new keyframe only when the pose is far from every stored one and there is room', () => {
    const bank = new KeyframeBank({ max: 3, newKeyframeDistance: 0.3 });
    expect(bank.wantsNewKeyframe(pose())).toBe(false); // empty bank: the first keyframe is requested by the drop, not here
    bank.add({ landmarks: pose(), id: 'front' });
    expect(bank.wantsNewKeyframe(pose())).toBe(false);
    const armsUp = pose({ 15: { x: 0.75, y: 0.15, visibility: 1 }, 16: { x: 0.25, y: 0.15, visibility: 1 }, 13: { x: 0.72, y: 0.3, visibility: 1 }, 14: { x: 0.28, y: 0.3, visibility: 1 } });
    expect(bank.wantsNewKeyframe(armsUp)).toBe(true);
    bank.add({ landmarks: armsUp, id: 'up' }); bank.add({ landmarks: pose({ 0: { x: 0.62, y: 0.25, visibility: 1 } }), id: 'turn' });
    expect(bank.size).toBe(3); expect(bank.wantsNewKeyframe(pose({ 0: { x: 0.3, y: 0.25, visibility: 1 } }))).toBe(false); // full
  });
  test('selects the nearest keyframe, cross-fades near a boundary, and does not flip-flop', () => {
    const bank = new KeyframeBank({ max: 4 });
    const armsUp = pose({ 15: { x: 0.75, y: 0.15, visibility: 1 }, 16: { x: 0.25, y: 0.15, visibility: 1 } });
    bank.add({ landmarks: pose(), id: 'front' }); bank.add({ landmarks: armsUp, id: 'up' });
    let sel = bank.select(pose());
    expect(sel[0].entry.id).toBe('front'); expect(sel.length).toBe(1); close(sel[0].weight, 1);
    const mid = pose({ 15: { x: 0.705, y: 0.42, visibility: 1 }, 16: { x: 0.295, y: 0.42, visibility: 1 } });
    sel = bank.select(mid);
    expect(sel.length).toBe(2); close(sel[0].weight + sel[1].weight, 1);
    const w = sel.map((s) => s.weight); expect(w[0]).toBeGreaterThan(0.3); expect(w[1]).toBeGreaterThan(0.3);
    const primary = sel[0].entry.id;
    // sweep the wrists from the "front" pose towards "up": find where the "up" keyframe becomes nearer
    const wrists = (y) => pose({ 15: { x: 0.7, y, visibility: 1 }, 16: { x: 0.3, y, visibility: 1 } });
    let boundary = null;
    for (let y = 0.7; y >= 0.15; y -= 0.005) { const d = bank.distances(wrists(y)); if (d[1] < d[0]) { boundary = y; break; } }
    expect(boundary).not.toBeNull();
    const fresh = new KeyframeBank({ max: 4 }); fresh.add({ landmarks: pose(), id: 'front' }); fresh.add({ landmarks: armsUp, id: 'up' });
    expect(fresh.select(wrists(0.7))[0].entry.id).toBe('front');
    // just past the boundary (up is only marginally nearer): the primary must NOT flip (hysteresis)
    expect(fresh.select(wrists(boundary - 0.01))[0].entry.id).toBe('front');
    expect(fresh.select(armsUp)[0].entry.id).toBe('up'); // clearly closer to the other one: switches
  });
});

test.describe('garment extraction', () => {
  const W = 64, H = 64;
  const rgba = (fn) => { const d = new Uint8ClampedArray(W * H * 4); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const [r, g, b] = fn(x, y); const o = (y * W + x) * 4; d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255; } return { data: d, width: W, height: H }; };
  const person = rgba((x, y) => (y > 44 ? [40, 40, 90] : [120, 120, 120]));   // grey top, blue trousers below y=44
  const key = rgba((x, y) => (y > 44 ? [40, 40, 90] : (x > 16 && x < 48 && y > 14 ? [220, 30, 30] : [120, 120, 120]))); // red garment on the top
  const cats = new Uint8Array(W * H); for (let y = 12; y < 64; y++) for (let x = 14; x < 50; x++) cats[y * W + x] = 4; // "clothes" covers top AND trousers
  test('keeps only what the try-on changed (the top), not the trousers', () => {
    const r = garmentAlpha({ key, person, cats, catsW: W, catsH: H });
    expect(r.usedDiff).toBe(true);
    expect(r.bbox.y + r.bbox.h).toBeLessThanOrEqual(56); // stops around the trousers line (dilated a little)
    expect(r.alpha[30 * W + 30]).toBe(255); expect(r.alpha[55 * W + 30]).toBe(0);
    expect(r.area).toBeGreaterThan(800);
  });
  test('when almost nothing changed it falls back to the clothes class', () => {
    const r = garmentAlpha({ key: person, person, cats, catsW: W, catsH: H });
    expect(r.usedDiff).toBe(false); expect(r.alpha[55 * W + 30]).toBe(255);
  });
  test('works with a lower-resolution class map and removes speckles', () => {
    const small = new Uint8Array(16 * 16); for (let y = 3; y < 12; y++) for (let x = 3; x < 12; x++) small[y * 16 + x] = 4; small[0] = 4; // stray pixel far away
    const r = garmentAlpha({ key, person: null, cats: small, catsW: 16, catsH: 16 });
    expect(r.alpha[0]).toBe(0); expect(r.alpha[30 * W + 30]).toBe(255);
    expect(r.bbox.x).toBeLessThanOrEqual(12); expect(r.bbox.x + r.bbox.w).toBeGreaterThanOrEqual(48);
  });
  test('component and dilation helpers', () => {
    const m = new Uint8Array(100); m[11] = 255; m[12] = 255; m[88] = 255;
    const { mask, area } = largestComponent(m, 10, 10); expect(area).toBe(2); expect(mask[88]).toBe(0);
    const d = dilateMask(m, 10, 10, 1); expect(d[0]).toBe(255); expect(d[33]).toBe(0);
  });
  test('empty result has no bbox', () => {
    const r = garmentAlpha({ key, person: null, cats: new Uint8Array(W * H), catsW: W, catsH: H });
    expect(r.bbox).toBeNull(); expect(r.area).toBe(0);
  });
});

test.describe('local tracking refinement (Lucas-Kanade on the mesh)', () => {
  const W = 160, H = 120;
  // smooth pseudo-random texture (sum of a few sinusoids): well conditioned for tracking
  const tex = (x, y) => 128 + 40 * Math.sin(x * 0.21 + y * 0.13) + 35 * Math.sin(x * 0.07 - y * 0.29 + 1) + 30 * Math.sin(x * 0.33 + y * 0.31 + 2) + 20 * Math.sin(-x * 0.11 + y * 0.05);
  const gray = (f) => { const d = new Float32Array(W * H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) d[y * W + x] = f(x, y); return { data: d, w: W, h: H }; };
  const grid = (cols, rows, x0, y0, x1, y1) => { const p = new Float32Array(cols * rows * 2); for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) { p[(j * cols + i) * 2] = x0 + (x1 - x0) * i / (cols - 1); p[(j * cols + i) * 2 + 1] = y0 + (y1 - y0) * j / (rows - 1); } return p; };

  test('recovers a known residual translation of the real texture', () => {
    const ref = gray(tex), cur = gray((x, y) => tex(x - 3, y + 2)); // content moved by (+3, -2)
    const cols = 6, rows = 6, pts = grid(cols, rows, 40, 30, 120, 90);
    const r = new MeshRefiner({ temporal: 0 }); r.setReference(ref);
    const { disp, conf } = r.refine(cur, pts, pts, cols, rows);
    let ok = 0;
    for (let v = 0; v < cols * rows; v++) { if (conf[v] > 0.5) { ok++; expect(Math.abs(disp[v * 2] - 3)).toBeLessThan(0.7); expect(Math.abs(disp[v * 2 + 1] + 2)).toBeLessThan(0.7); } }
    expect(ok).toBeGreaterThan(cols * rows * 0.6);
  });
  test('compensates for the warp scale (content zoomed 1.25x about a point)', () => {
    const ref = gray(tex), s = 1.25, cx = 80, cy = 60;
    const cur = gray((x, y) => tex(cx + (x - cx) / s, cy + (y - cy) / s));
    const cols = 5, rows = 5, src = grid(cols, rows, 50, 40, 110, 80);
    const dst = new Float32Array(src.length); const mult = new Float32Array(src.length);
    for (let v = 0; v < cols * rows; v++) { dst[v * 2] = cx + (src[v * 2] - cx) * s; dst[v * 2 + 1] = cy + (src[v * 2 + 1] - cy) * s; mult[v * 2] = s; mult[v * 2 + 1] = 0; }
    const r = new MeshRefiner({ temporal: 0 }); r.setReference(ref);
    const { disp, conf } = r.refine(cur, src, dst, cols, rows, mult);
    let checked = 0; for (let v = 0; v < cols * rows; v++) if (conf[v] > 0.5) { checked++; expect(Math.hypot(disp[v * 2], disp[v * 2 + 1])).toBeLessThan(0.8); }
    expect(checked).toBeGreaterThan(10);
  });
  test('flat, textureless regions are not trusted and stay where the warp put them', () => {
    const ref = gray(() => 100), cur = gray(() => 100);
    const cols = 4, rows = 4, pts = grid(cols, rows, 40, 30, 100, 80);
    const r = new MeshRefiner(); r.setReference(ref);
    const { disp, conf } = r.refine(cur, pts, pts, cols, rows);
    for (let v = 0; v < cols * rows; v++) { expect(conf[v]).toBeLessThan(0.05); expect(Math.hypot(disp[v * 2], disp[v * 2 + 1])).toBeLessThan(0.2); }
  });
  test('toGray and bilinear', () => {
    const g = toGray({ data: new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]), width: 2, height: 2 });
    close(g.data[0], 76.245, 0.01); close(bilinear(g, 0.5, 0), (g.data[0] + g.data[1]) / 2, 1e-3);
  });
});
