// AI Live try-on via Decart's Lucy V-TON realtime model (the model behind Anywear).
// The camera stream goes to Decart over WebRTC; the edited video (you wearing the garment) comes back.
// Bundled SDK: vendor/decart/decart-sdk.js (build: npm run build:decart).
const DECART_PRICE_PER_SECOND = 0.02; // USD, 720p realtime generation (Decart public pricing)

// What is being worn, guessed from the product's alt text / file name ("black-leather-jacket.jpg" -> top).
// There is no type picker: dragging a picture is the whole interface.
function kindFromHint(hint) {
  const t = String(hint || '').toLowerCase();
  if (/\b(dress|gown|jumpsuit|romper|skirt|kaftan|abaya|saree|sari|lehenga|kurta set)\b/.test(t)) return 'dress';
  if (/\b(jeans?|pants?|trousers?|chinos?|joggers?|leggings?|shorts|denim|cargo|sweatpants|bottoms?)\b/.test(t)) return 'pants';
  return 'shirt';
}

function garmentPrompt(kind, description) {
  const base = kind === 'dress' ? 'Substitute the current outfit with the dress shown in the reference image'
    : kind === 'pants' ? 'Substitute the current pants with the pants shown in the reference image'
      : 'Substitute the current top with the garment shown in the reference image';
  const extra = (description || '').trim();
  return extra ? `${base}: ${extra}` : base;
}

class DecartLive {
  constructor(handlers = {}) {
    this.h = handlers; this.rt = null; this.client = null; this.timer = null; this.startedAt = 0;
    this.seconds = 0; this.state = 'disconnected'; this.limitSeconds = 120; this.active = false;
  }
  static available() { return typeof window !== 'undefined' && !!window.DecartSDK; }
  get connected() { return !!this.rt && this.state !== 'disconnected'; }
  estimatedCost() { return this.seconds * DECART_PRICE_PER_SECOND; }

  // stream: the live camera MediaStream. Resolves once the connection is established (it may queue first).
  async connect({ apiKey, stream, limitSeconds = 120, garment = null, prompt = null }) {
    if (this.active) return;
    if (!DecartLive.available()) throw new Error('Decart SDK is not loaded');
    this.active = true; this.limitSeconds = limitSeconds; this.seconds = 0;
    try {
      const { createDecartClient, models } = window.DecartSDK;
      let clientKey = apiKey;
      try { // mint a short-lived, model- and duration-limited token so the permanent key never goes to the media session
        const base = createDecartClient({ apiKey });
        const token = await base.tokens.create({ expiresIn: 300, allowedModels: ['lucy-vton-latest'], constraints: { realtime: { maxSessionDuration: limitSeconds } } });
        clientKey = token.apiKey;
      } catch (tokenError) { console.warn('Client token unavailable, using the key directly', tokenError); }
      this.client = createDecartClient({ apiKey: clientKey });
      const model = models.realtime('lucy-vton-latest');
      const initialState = garment ? { image: garment, prompt: { text: prompt || garmentPrompt('shirt'), enhance: false } } : undefined;
      this.rt = await this.client.realtime.connect(stream, {
        model, mirror: true, initialState,
        onRemoteStream: (remote) => { this.h.onRemoteStream && this.h.onRemoteStream(remote); },
        onConnectionChange: (state) => this.handleState(state),
        onQueuePosition: (q) => this.h.onQueue && this.h.onQueue(q)
      });
      if (this.state === 'disconnected') this.state = 'connected'; // some SDK versions only emit state changes after connect resolves
      this.rt.on('error', (error) => this.h.onError && this.h.onError(error));
      this.rt.on('generationTick', (tick) => { this.seconds = tick.seconds; this.h.onTick && this.h.onTick(tick.seconds, this.estimatedCost()); });
      this.rt.on('sessionEnded', (e) => { this.h.onEnded && this.h.onEnded(e.reason || 'Session ended'); this.disconnect(); });
      this.rt.on('generationEnded', (e) => { this.seconds = e.seconds; this.h.onEnded && this.h.onEnded(e.reason || 'Generation ended'); });
      this.startedAt = Date.now();
      // Client-side safety net so a forgotten tab can never bill past the limit.
      this.timer = setInterval(() => { if ((Date.now() - this.startedAt) / 1000 >= this.limitSeconds + 2) { this.h.onEnded && this.h.onEnded('Session limit reached'); this.disconnect(); } }, 1000);
    } catch (error) {
      this.active = false; this.rt = null; throw error;
    }
  }
  handleState(state) { this.state = state; this.h.onState && this.h.onState(state); }
  // image: File | Blob | URL string; kind: 'shirt' | 'hoodie' | 'jacket' | 'dress'
  async setGarment(image, kind = 'shirt', description = '') {
    if (!this.rt) throw new Error('AI session is not connected');
    await this.rt.setImage(image, { prompt: garmentPrompt(kind, description), enhance: false });
  }
  disconnect() {
    clearInterval(this.timer); this.timer = null;
    try { if (this.rt) this.rt.disconnect(); } catch (error) { console.warn(error); }
    this.rt = null; this.client = null; this.active = false; this.handleState('disconnected');
  }
}
if (typeof window !== 'undefined') { window.DecartLive = DecartLive; window.garmentPrompt = garmentPrompt; window.kindFromHint = kindFromHint; }
if (typeof module !== 'undefined') module.exports = { DecartLive, garmentPrompt, kindFromHint };
