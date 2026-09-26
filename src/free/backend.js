// Talks to the local try-on server (server/tryon_server.py) that runs the AI keyframe model on your own GPU.
//   GET  /health -> { ok: true, engine, ... }
//   POST /tryon  { person: dataURL, garment: dataURL, category: "upper"|"lower"|"overall", steps?, seed? }
//        -> { image: dataURL, seconds, engine }
const DEFAULT_BACKEND_URL = 'http://127.0.0.1:7861';

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(r.error); r.readAsDataURL(blob); });
}
async function dataUrlToBlob(url) { return (await fetch(url)).blob(); }

const KIND_TO_CATEGORY = { shirt: 'upper', hoodie: 'upper', jacket: 'upper', dress: 'overall', pants: 'lower' };

class TryOnBackend {
  constructor(baseUrl = DEFAULT_BACKEND_URL) { this.baseUrl = String(baseUrl).replace(/\/+$/, ''); }

  // -> { ok: true, engine, ... } | { ok: false, error }
  async health(timeoutMs = 2500) {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/health`, { signal: ctl.signal });
      if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
      return { ok: true, ...(await response.json()) };
    } catch (error) { return { ok: false, error: error.name === 'AbortError' ? 'timed out' : (error.message || String(error)) }; }
    finally { clearTimeout(timer); }
  }

  // person / garment: Blobs. Resolves to the try-on photo (a PNG Blob, same size as `person`).
  async generate({ person, garment, category = 'upper', steps, seed, signal, timeoutMs = 300000 }) {
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    if (signal) { if (signal.aborted) ctl.abort(); else signal.addEventListener('abort', onAbort, { once: true }); }
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const body = JSON.stringify({ person: await blobToDataUrl(person), garment: await blobToDataUrl(garment), category, steps, seed });
      let response;
      try { response = await fetch(`${this.baseUrl}/tryon`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: ctl.signal }); }
      catch (error) {
        if (signal && signal.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
        if (error.name === 'AbortError') throw new Error('The try-on server took too long');
        throw new Error(`Cannot reach the try-on server at ${this.baseUrl}. Is it running?`);
      }
      let data = null; try { data = await response.json(); } catch (error) { /* not JSON */ }
      if (!response.ok || !data || !data.image) throw new Error((data && data.error) || `The try-on server answered HTTP ${response.status}`);
      return { blob: await dataUrlToBlob(data.image), seconds: data.seconds, engine: data.engine };
    } finally { clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); }
  }
}

if (typeof window !== 'undefined') window.FreeBackend = { TryOnBackend, DEFAULT_BACKEND_URL, KIND_TO_CATEGORY, blobToDataUrl, dataUrlToBlob };
if (typeof module !== 'undefined') module.exports = { TryOnBackend, DEFAULT_BACKEND_URL, KIND_TO_CATEGORY };
