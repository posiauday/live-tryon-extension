// A fake DecartSDK for tests (no key, no network, no cost). Install with page.addInitScript(installFakeSdk):
// it records every SDK call in window.__calls and returns a green "AI output" stream.
function installFakeSdk() {
  window.__calls = [];
  const fake = {
    createDecartClient: ({ apiKey }) => ({
      tokens: { create: async (o) => { window.__calls.push(['token', apiKey, JSON.stringify(o)]); return { apiKey: 'ek_short_lived' }; } },
      realtime: {
        connect: async (stream, opts) => {
          window.__calls.push(['connect', apiKey, opts.model.name, opts.mirror, stream.getVideoTracks().length]);
          opts.onConnectionChange('connected');
          const c = document.createElement('canvas'); c.width = 640; c.height = 360; const x = c.getContext('2d'); x.fillStyle = '#0a0'; x.fillRect(0, 0, 640, 360);
          opts.onRemoteStream(c.captureStream(15));
          return {
            on() {}, off() {}, isConnected: () => true,
            setImage: async (img, o) => { window.__calls.push(['setImage', img instanceof Blob, img.size > 0, o.prompt, o.enhance]); },
            disconnect: () => window.__calls.push(['disconnect'])
          };
        }
      }
    }),
    models: { realtime: (name) => ({ name, fps: { ideal: 30, max: 30 }, width: 1280, height: 720 }) }
  };
  Object.defineProperty(window, 'DecartSDK', { get: () => fake, set: () => {} });
}
module.exports = { installFakeSdk };
