// Glue between the page and the free pipeline (src/free/*): models, local server status, countdown / progress overlay,
// the render loop, and the Free-mode card. Exposes window.freeMode for camera.js.
(function () {
  const $ = (id) => document.getElementById(id);
  const S = {
    pipeline: null, detector: null, segmenter: null, backend: new FreeBackend.TryOnBackend(new URLSearchParams(location.search).get('backend') || undefined),
    modelsPromise: null, active: false, health: { ok: false }, healthTimer: null, genTimer: null, running: false,
    fps: 0, frames: 0, fpsT0: 0, video: null, canvas: null, options: { tracking: false, autoAngles: true }
  };
  const el = {
    overlay: $('freeOverlay'), big: $('freeOverlayBig'), text: $('freeOverlayText'), backendState: $('freeBackendState'),
    backendUrl: $('freeBackendUrl'), bank: $('freeBank'), fps: $('freeFps'), phase: $('freePhase'), checkBtn: $('freeCheckBtn'),
    resetBtn: $('freeResetBtn'), optTracking: $('optTracking'), optAngles: $('optAngles'), models: $('freeModels')
  };
  const toast = (t, ms) => (window.showToast ? window.showToast(t, ms) : null);

  function overlay(big, text) {
    el.overlay.hidden = !big && !text; el.big.textContent = big || ''; el.text.textContent = text || '';
  }

  async function ensureModels() {
    if (S.modelsPromise) return S.modelsPromise;
    S.modelsPromise = (async () => {
      if (window.__testDetector && window.__testSegmenter) { S.detector = window.__testDetector; S.segmenter = window.__testSegmenter; el.models.textContent = 'Ready (test)'; return; } // test seam
      el.models.textContent = 'Loading pose model...';
      if (!window.MediaPipeLoader || !MediaPipeLoader.available()) throw new Error('Free mode needs the extension (open it from the toolbar icon), not a plain file page.');
      S.detector = new PoseDetector(); await S.detector.initialize();
      el.models.textContent = 'Loading segmentation model...';
      S.segmenter = new BodySegmentation(); await S.segmenter.initialize();
      el.models.textContent = 'Ready';
    })().catch((error) => { S.modelsPromise = null; el.models.textContent = 'Failed'; throw error; });
    return S.modelsPromise;
  }

  async function checkBackend() {
    el.backendState.textContent = 'Checking...'; el.backendState.dataset.tone = 'warn';
    S.health = await S.backend.health();
    if (S.health.ok) { el.backendState.textContent = `Online · ${S.health.engine || 'server'}`; el.backendState.dataset.tone = 'ok'; }
    else { el.backendState.textContent = 'Offline'; el.backendState.dataset.tone = 'bad'; }
    el.backendUrl.textContent = S.backend.baseUrl;
    return S.health;
  }

  function createPipeline() {
    if (S.pipeline) return S.pipeline;
    S.pipeline = new FreePipeline({
      video: S.video, canvas: S.canvas, detector: S.detector, segmenter: S.segmenter, backend: S.backend, options: Object.assign({}, S.options, window.__freeOptions || {}),
      onEvent: (type, data) => onEvent(type, data)
    });
    return S.pipeline;
  }

  function onEvent(type, data) {
    if (type === 'countdown') {
      if (data.n === null) overlay('', data.hint); else if (data.n > 0) overlay(String(data.n), 'Face the camera and hold still. Keep your head, shoulders and chest in view.'); else overlay('', 'Capturing...');
    } else if (type === 'generating') {
      if (data.reason === 'first') {
        clearInterval(S.genTimer); const t0 = performance.now();
        const tick = () => overlay('', `Making your look on your PC... ${Math.floor((performance.now() - t0) / 1000)}s. You can keep moving.`);
        tick(); S.genTimer = setInterval(tick, 500);
      } else { toast('Adding a new angle in the background...', 2500); }
    } else if (type === 'keyframe') {
      clearInterval(S.genTimer); overlay('', '');
      el.bank.textContent = `${data.count} / ${S.options.maxKeyframes || 6}`;
      toast(data.reason === 'first' ? `Ready. Took ${data.seconds ? data.seconds.toFixed(0) + 's' : 'a moment'}. Move around: new angles are added automatically.` : `Angle added (${data.count} keyframes).`, 4000);
    } else if (type === 'error') {
      clearInterval(S.genTimer); overlay('', '');
      toast(data.message, 7000);
      if (/Cannot reach|took too long/.test(data.message)) { el.backendState.textContent = 'Offline'; el.backendState.dataset.tone = 'bad'; }
    } else if (type === 'phase') {
      el.phase.textContent = { idle: 'Drop a garment', countdown: 'Get ready', generating: 'Generating', live: 'Live' }[data.phase] || data.phase;
      if (data.phase === 'idle') { overlay('', ''); el.bank.textContent = `0 / ${S.options.maxKeyframes || 6}`; }
    }
    if (window.postStatus && (type === 'phase' || type === 'keyframe')) window.postStatus(data.phase ? `Free · ${el.phase.textContent}` : `Free · ${S.pipeline.bank.size} keyframes`);
  }

  // ---------- render loop (per video frame) ----------
  function loop() {
    if (!S.active || !S.running) return;
    const next = () => { if (!S.active) return; if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) S.video.requestVideoFrameCallback(loop); else requestAnimationFrame(loop); };
    if (!S.pipeline) { next(); return; }
    S.pipeline.update().catch((error) => console.warn('free pipeline', error)).finally(() => {
      S.frames++; const now = performance.now();
      if (now - S.fpsT0 >= 1000) { S.fps = S.frames; S.frames = 0; S.fpsT0 = now; el.fps.textContent = `${S.fps}${S.pipeline.renderer ? ' · ' + S.pipeline.renderer.kind : ''}`; }
      next();
    });
  }

  // ---------- public API ----------
  async function enter({ video, canvas }) {
    S.video = video; S.canvas = canvas; S.active = true; el.backendUrl.textContent = S.backend.baseUrl;
    checkBackend(); clearInterval(S.healthTimer); S.healthTimer = setInterval(() => { if (S.active && (!S.pipeline || S.pipeline.phase === 'idle')) checkBackend(); }, 6000);
    try { await ensureModels(); } catch (error) { toast(error.message || 'Could not load the pose models.', 8000); return; }
    createPipeline(); S.running = true; S.fpsT0 = performance.now(); loop();
  }
  function leave() {
    S.active = false; S.running = false; clearInterval(S.healthTimer); clearInterval(S.genTimer);
    if (S.pipeline) S.pipeline.reset(); overlay('', '');
  }
  async function setGarment(blob, kind) {
    if (!S.pipeline) { try { await ensureModels(); createPipeline(); S.running = true; loop(); } catch (error) { toast(error.message, 8000); return; } }
    const health = await checkBackend();
    if (!health.ok) toast('The try-on server is not running yet. Start it (see the Free card), then drop the garment again. Nothing was sent.', 9000);
    if (!health.ok) return;
    S.pipeline.setGarment(blob, kind);
  }
  function reset() { if (S.pipeline) S.pipeline.reset(); overlay('', ''); }
  function setOption(name, value) { S.options[name] = value; if (S.pipeline) S.pipeline.options[name] = value; }

  el.checkBtn.addEventListener('click', checkBackend);
  el.resetBtn.addEventListener('click', () => { reset(); toast('Garment removed.'); });
  el.optTracking.addEventListener('change', () => setOption('tracking', el.optTracking.checked));
  el.optAngles.addEventListener('change', () => setOption('autoAngles', el.optAngles.checked));
  el.bank.textContent = '0 / 6';

  window.freeMode = { enter, leave, setGarment, reset, checkBackend, get pipeline() { return S.pipeline; }, get backend() { return S.backend; }, get state() { return S; } };
})();
