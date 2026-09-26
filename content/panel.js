// Injected into the current tab when the toolbar icon is clicked. Shows the try-on as a floating,
// draggable, minimizable panel ON the page, so garments can be dragged straight from the shop page into it.
// The UI lives in an extension iframe (camera/camera.html?embed=1); the chrome (title bar) is in a shadow root
// so the host page's CSS cannot touch it.
//
// Drag & drop: Chrome does not deliver drag events from the page into an extension iframe (it lives in another
// process). So while something is being dragged, a drop zone in THIS document covers the panel; it receives the drop
// and passes the image to the iframe through chrome.runtime messaging (authenticated: a web page cannot send these).
(() => {
  if (window.__tryonPanel) { window.__tryonPanel.toggle(); return; }

  const SIZES = { normal: { w: 480, h: 640 }, large: { w: 780, h: 780 } };
  const BAR = 40;
  const MAX_BYTES = 12 * 1024 * 1024;
  let size = 'normal';
  let minimized = false;
  let pos = null; // { left, top }
  const pid = (self.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Math.random()).slice(2);

  const host = document.createElement('div');
  host.id = '__tryon-panel-host';
  host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; top: 0; left: 0; width: 0; height: 0;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      * { box-sizing: border-box; }
      .panel { position: fixed; display: flex; flex-direction: column; overflow: hidden; border: 1px solid rgba(255,255,255,.14); border-radius: 16px; background: #0a0c11; box-shadow: 0 24px 70px rgba(0,0,0,.55); font: 13px/1.4 system-ui, "Segoe UI", sans-serif; color: #e9ecf2; }
      .bar { flex: 0 0 ${BAR}px; display: flex; align-items: center; gap: 8px; padding: 0 8px 0 12px; background: linear-gradient(135deg, #2a2560, #1b2a5c); cursor: grab; user-select: none; touch-action: none; }
      .bar:active { cursor: grabbing; }
      .logo { width: 20px; height: 20px; border-radius: 6px; background: linear-gradient(135deg, #7c6cf6, #5b8cf7); flex: none; }
      .title { font-weight: 650; letter-spacing: -.01em; }
      .status { flex: 1; min-width: 0; overflow: hidden; color: #b9bfd3; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
      button { all: unset; display: grid; place-items: center; width: 28px; height: 28px; border-radius: 8px; color: #dfe3f1; font: 600 16px/1 system-ui; cursor: pointer; }
      button:hover { background: rgba(255,255,255,.14); }
      button:focus-visible { outline: 2px solid #5b8cf7; }
      iframe { flex: 1; width: 100%; border: 0; background: #0a0c11; }
      .panel.min iframe { visibility: hidden; height: 0; flex: 0 0 0; }
      /* drop zone: only present while something is being dragged; it is the drop target for host-page drags */
      .dz { position: absolute; inset: 0; z-index: 5; display: none; flex-direction: column; align-items: center; justify-content: center; gap: 8px; margin: 0; border: 3px dashed #7c6cf6; border-radius: 16px; background: rgba(28, 24, 70, .88); color: #fff; font: 650 16px/1.3 system-ui, "Segoe UI", sans-serif; text-align: center; }
      .dz * { pointer-events: none; }
      .dz small { font-weight: 500; font-size: 12px; opacity: .8; }
      .panel.drag .dz { display: flex; }
      .panel.drag.over .dz { background: rgba(92, 72, 230, .92); border-color: #fff; }
    </style>
    <div class="panel" role="dialog" aria-label="Live Try-On">
      <div class="bar" id="bar">
        <span class="logo"></span><span class="title" id="title">Try-On</span><span class="status" id="status"></span>
        <button data-act="size" title="Bigger / smaller">&#x2922;</button>
        <button data-act="min" title="Minimize">&#x2013;</button>
        <button data-act="close" title="Close">&#x2715;</button>
      </div>
      <iframe allow="camera; microphone; autoplay; clipboard-write; fullscreen" title="Live Try-On"></iframe>
      <div class="dz" id="dz"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4m0 0-4 4m4-4 4 4M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/></svg><span>Drop here to wear it</span><small>Release the product image anywhere on this panel</small></div>
    </div>`;
  const panel = root.querySelector('.panel');
  const bar = root.getElementById('bar');
  const statusEl = root.getElementById('status');
  const frame = root.querySelector('iframe');
  const dz = root.getElementById('dz');
  try { root.getElementById('title').title = `Live Try-On v${chrome.runtime.getManifest().version}`; } catch (error) { /* stubbed in tests */ }
  const frameUrl = new URL(chrome.runtime.getURL('camera/camera.html')); frameUrl.searchParams.set('embed', '1'); frameUrl.searchParams.set('pid', pid);
  frame.src = frameUrl.href;

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  function layout() {
    const want = SIZES[size];
    const w = Math.min(want.w, window.innerWidth - 16), h = minimized ? BAR : Math.min(want.h, window.innerHeight - 16);
    if (!pos) pos = { left: window.innerWidth - w - 16, top: 16 };
    pos.left = clamp(pos.left, 8 - w + 120, window.innerWidth - 120); // keep part of the bar reachable
    pos.top = clamp(pos.top, 0, window.innerHeight - BAR);
    Object.assign(panel.style, { width: `${w}px`, height: `${h}px`, left: `${pos.left}px`, top: `${pos.top}px` });
    panel.classList.toggle('min', minimized);
  }

  // drag by the title bar (pointer capture keeps the drag alive while the pointer is over the iframe)
  let drag = null;
  bar.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    drag = { x: e.clientX - pos.left, y: e.clientY - pos.top }; bar.setPointerCapture(e.pointerId);
  });
  bar.addEventListener('pointermove', (e) => { if (!drag) return; pos.left = e.clientX - drag.x; pos.top = e.clientY - drag.y; layout(); });
  const endDrag = () => { drag = null; };
  bar.addEventListener('pointerup', endDrag); bar.addEventListener('pointercancel', endDrag);
  bar.addEventListener('dblclick', (e) => { if (!e.target.closest('button')) { minimized = !minimized; layout(); } });

  // ---------- drag & drop from the page ----------
  const DRAG_TYPES = ['Files', 'text/html', 'text/uri-list', 'text/plain', 'DownloadURL'];
  const isImageDrag = (dt) => !!dt && Array.from(dt.types || []).some((t) => DRAG_TYPES.includes(t));
  let lastDragEvent = 0; let watchdog = null;
  function showDropZone() {
    lastDragEvent = Date.now(); panel.classList.add('drag');
    if (!watchdog) watchdog = setInterval(() => { if (Date.now() - lastDragEvent > 900) hideDropZone(); }, 300); // drag cancelled (Esc) -> no dragend here
  }
  function hideDropZone() { panel.classList.remove('drag', 'over'); clearInterval(watchdog); watchdog = null; }
  const onDragStartOrEnter = (e) => { if (isImageDrag(e.dataTransfer) && !root.contains(e.target)) showDropZone(); };
  const onDragOverAny = () => { if (panel.classList.contains('drag')) lastDragEvent = Date.now(); };
  const onDragLeaveWindow = (e) => { if (e.clientX <= 0 || e.clientY <= 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight) hideDropZone(); };
  window.addEventListener('dragstart', onDragStartOrEnter, true);
  window.addEventListener('dragenter', onDragStartOrEnter, true);
  window.addEventListener('dragover', onDragOverAny, true);
  window.addEventListener('dragleave', onDragLeaveWindow, true);
  window.addEventListener('dragend', hideDropZone, true);
  window.addEventListener('drop', hideDropZone, true);

  dz.addEventListener('dragenter', (e) => { e.preventDefault(); panel.classList.add('over'); });
  dz.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); lastDragEvent = Date.now(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; panel.classList.add('over'); });
  dz.addEventListener('dragleave', () => panel.classList.remove('over'));
  dz.addEventListener('drop', (e) => {
    e.preventDefault(); e.stopPropagation(); hideDropZone();
    const dt = e.dataTransfer; // read everything synchronously: it is unavailable after the first await
    const payload = {
      files: Array.from(dt.files || []).filter((f) => f.type.startsWith('image/')),
      html: dt.getData('text/html'), uriList: dt.getData('text/uri-list'), text: dt.getData('text/plain'), download: dt.getData('DownloadURL')
    };
    if (minimized) { minimized = false; layout(); }
    forwardDrop(payload);
  });

  // the image URL of a dragged page element (prefers the <img> over a surrounding link) and any text that says what it is
  function inspect({ html, uriList, text, download }) {
    const candidates = []; let alt = '';
    if (download) { const m = download.match(/^[^:]*:[^:]*:(.+)$/); if (m) candidates.push(m[1]); } // Chrome: "mime:filename:url"
    if (html) {
      try { const img = new DOMParser().parseFromString(html, 'text/html').querySelector('img'); if (img) { candidates.push(img.getAttribute('src') || ''); alt = `${img.getAttribute('alt') || ''} ${img.getAttribute('title') || ''}`; } } catch (error) { /* ignore */ }
    }
    candidates.push((uriList || '').split('\n')[0].trim(), (text || '').split('\n')[0].trim());
    let url = '';
    for (const c of candidates) {
      if (!c) continue;
      try { const u = new URL(c.startsWith('//') ? `https:${c}` : c, location.href); if (u.protocol === 'http:' || u.protocol === 'https:' || (u.protocol === 'data:' && c.startsWith('data:image/'))) { url = u.href; break; } } catch (error) { /* try the next */ }
    }
    let name = ''; try { name = url.startsWith('http') ? decodeURIComponent(new URL(url).pathname.split('/').pop() || '') : ''; } catch (error) { /* ignore */ }
    return { url, hint: `${alt} ${name}`.trim() };
  }
  const toDataUrl = (blob) => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(blob); });
  function send(message) { try { chrome.runtime.sendMessage({ type: 'tryon-drop', pid, ...message }); } catch (error) { setStatus('Could not reach the try-on panel'); } }
  function setStatus(text) { statusEl.textContent = text; setTimeout(() => { if (statusEl.textContent === text) statusEl.textContent = ''; }, 4000); }

  async function forwardDrop(payload) {
    try {
      const { url, hint } = inspect(payload);
      if (payload.files.length && payload.files[0].size <= MAX_BYTES) { send({ kind: 'data', dataUrl: await toDataUrl(payload.files[0]), hint: `${hint} ${payload.files[0].name}`.trim() }); return; }
      if (!url) { setStatus('That is not an image'); return; }
      try { // first try from the page itself (works whenever the image server allows it, and needs no permission)
        const response = await fetch(url);
        const blob = await response.blob();
        if (response.ok && blob.type.startsWith('image/') && blob.size <= MAX_BYTES) { send({ kind: 'data', dataUrl: await toDataUrl(blob), hint }); return; }
      } catch (error) { /* blocked by the site's CORS policy: let the extension fetch it */ }
      send({ kind: 'url', url, hint });
    } catch (error) { setStatus('Could not read that image'); }
  }

  function close() {
    hideDropZone();
    for (const [type, fn] of [['dragstart', onDragStartOrEnter], ['dragenter', onDragStartOrEnter], ['dragover', onDragOverAny], ['dragleave', onDragLeaveWindow], ['dragend', hideDropZone], ['drop', hideDropZone]]) window.removeEventListener(type, fn, true);
    window.removeEventListener('resize', layout); window.removeEventListener('message', onMessage); host.remove(); delete window.__tryonPanel;
  }
  root.addEventListener('click', (e) => {
    const act = e.target.closest('button') && e.target.closest('button').dataset.act;
    if (act === 'min') { minimized = !minimized; layout(); }
    else if (act === 'size') { size = size === 'normal' ? 'large' : 'normal'; minimized = false; layout(); }
    else if (act === 'close') close();
  });

  // status text from the try-on iframe ("AI · Live", cost...), so it is visible while minimized
  function onMessage(event) {
    if (event.source !== frame.contentWindow || !event.data || event.data.tryon !== 'status') return;
    statusEl.textContent = String(event.data.text || '').slice(0, 80);
  }
  window.addEventListener('message', onMessage);
  window.addEventListener('resize', layout);

  document.documentElement.appendChild(host);
  layout();
  window.__tryonPanel = {
    toggle() { if (!host.isConnected) { document.documentElement.appendChild(host); } minimized = false; layout(); },
    close
  };
})();
