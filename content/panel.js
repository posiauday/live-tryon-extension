// Injected into the current tab when the toolbar icon is clicked. Shows the try-on as a floating,
// draggable, minimizable panel ON the page, so garments can be dragged straight from the shop page into it.
// The UI lives in an extension iframe (camera/camera.html?embed=1); the chrome (title bar) is in a shadow root
// so the host page's CSS cannot touch it.
(() => {
  if (window.__tryonPanel) { window.__tryonPanel.toggle(); return; }

  const SIZES = { normal: { w: 480, h: 740 }, large: { w: 760, h: 760 } };
  const BAR = 40;
  let size = 'normal';
  let minimized = false;
  let pos = null; // { left, top }

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
    </style>
    <div class="panel" role="dialog" aria-label="Live Try-On">
      <div class="bar" id="bar">
        <span class="logo"></span><span class="title" id="title">Try-On</span><span class="status" id="status"></span>
        <button data-act="size" title="Bigger / smaller">&#x2922;</button>
        <button data-act="min" title="Minimize">&#x2013;</button>
        <button data-act="close" title="Close">&#x2715;</button>
      </div>
      <iframe allow="camera; microphone; autoplay; clipboard-write; fullscreen" title="Live Try-On"></iframe>
    </div>`;
  const panel = root.querySelector('.panel');
  const bar = root.getElementById('bar');
  const statusEl = root.getElementById('status');
  const frame = root.querySelector('iframe');
  try { root.getElementById('title').title = `Live Try-On v${chrome.runtime.getManifest().version}`; } catch (error) { /* stubbed in tests */ }
  const frameUrl = new URL(chrome.runtime.getURL('camera/camera.html')); frameUrl.searchParams.set('embed', '1');
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

  function close() { window.removeEventListener('resize', layout); window.removeEventListener('message', onMessage); host.remove(); delete window.__tryonPanel; }
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
