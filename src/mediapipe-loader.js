// Loads the locally bundled MediaPipe Tasks Vision runtime (MV3 forbids remote code).
(function () {
  const SRC = document.currentScript && document.currentScript.src;
  const VENDOR = new URL('../vendor/', SRC || location.href).href;
  let cached = null;
  const MediaPipeLoader = {
    vendorUrl: VENDOR,
    modelUrl: (name) => new URL(`models/${name}`, VENDOR).href,
    // Dynamic import of an ES module is blocked on file:// pages, so ML only runs from the
    // extension (chrome-extension://) or over http(s).
    available: () => location.protocol !== 'file:',
    async load() {
      if (!MediaPipeLoader.available()) throw new Error('MediaPipe needs the extension or an http(s) page (not file://)');
      if (!cached) {
        cached = (async () => {
          const vision = await import(new URL('mediapipe/vision_bundle.mjs', VENDOR).href);
          const fileset = await vision.FilesetResolver.forVisionTasks(new URL('mediapipe/wasm', VENDOR).href);
          return { vision, fileset };
        })();
      }
      return cached;
    }
  };
  window.MediaPipeLoader = MediaPipeLoader;
})();
