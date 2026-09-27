# Research log: live virtual try-on (Chrome extension)

Written 2026-09-27. This is a full record of the investigation for a version of "Anywear"-style live try-on that
runs free, on the user's own PC. It complements [ROADMAP-free-tryon.md](ROADMAP-free-tryon.md) (the tiered
6/10 -> 8/10 -> 9-10/10 plan, written earlier) by recording, in one place, exactly what was tried, what the
evidence actually showed, what got built and verified, and what is still open. Every claim below is either a
citation (with a link) or a number I personally measured on the user's machine; where I could not verify
something, it says so.

## 1. The goal

Recreate the user experience of the Anywear Chrome extension (drag any garment photo from a shop page onto a
live webcam feed, see it worn, moving with the body) **without paying Decart's per-second API**, running instead
on the user's own PC (Windows, NVIDIA RTX 2070 Super, 8 GB VRAM). A paid mode using Decart's actual API (the
model Anywear itself uses) was also built, as the ceiling of quality/latency to compare against.

## 2. What Anywear/Decart actually is (confirmed)

Anywear is built by Decart on **Lucy V-TON**, a real-time autoregressive video-diffusion model (Diffusion
Forcing + self-anchoring), served from Decart's own datacenter GPUs, streamed over WebRTC. Public pricing is
about **$0.02/second** (~$1.20/minute). Sources: [Decart Lucy V-TON docs](https://docs.platform.decart.ai/models/realtime/virtual-try-on),
[Anywear](https://anywear.decart.ai/), [MirageLSD / Lucy technical blog](https://decart.ai/blog).

## 3. What was built and verified (working today)

### 3.1 "Live AI" mode — Decart Lucy V-TON, paid, real
- Chrome MV3 extension; a floating on-page panel (shadow-DOM chrome + extension iframe) injected on any shop
  page via the toolbar icon; drag a product image from the page onto the panel.
- `@decartai/sdk`, bundled locally (MV3 forbids remote code), WebRTC session, short-lived per-session client
  token capped at 60 seconds server-side + a client-side timer (double enforcement of the cost cap).
- One minute per garment: session starts on drop, ends automatically at 60s or on "Remove garment", garment and
  state are wiped, nothing re-bills until a new drop.
- Fixed along the way: MV3's default CSP blocks WebAssembly (MediaPipe/Decart's WASM failed until
  `wasm-unsafe-eval` was added); Chrome delivers **no** drag events from a host page into an extension iframe
  (a different process), so drops are caught by a page-level drop zone and relayed via `chrome.runtime`
  messaging; big shops (H&M, Zara, ...) serve product images with no CORS headers, so `<all_urls>` host
  permission is used to fetch the image directly.
- Status: works, tested with Playwright end-to-end against a mock of the Decart SDK. **Never tested against a
  live Decart session with real billing** (no key was used by me; the user tests with their own key).

### 3.2 "Free" mode — one AI photo + live tracking, on the user's own GPU
- Architecture ("keyframe + warp"): drop a garment -> 3-2-1 countdown -> one photo of the user is sent, with the
  garment, to a **local Python server** running an image-based try-on model -> the returned photo is cut down to
  just the garment pixels -> that garment image is warped live onto the tracked body every frame (MediaPipe
  Pose Landmarker + Moving Least Squares similarity warp on a 12x14 mesh, WebGL renderer with a Canvas2D
  fallback, arms/head redrawn over the garment via MediaPipe multiclass segmentation, room-light matching).
- New pose (turn, arms up) triggers another background AI photo; a small pose-indexed keyframe bank (up to 6,
  cross-faded, with hysteresis) picks the nearest one live, so most movement needs no new AI call.
- Local server: `server/tryon_server.py`. Two engines: `mock` (no AI, pastes the garment on the photo, for
  wiring checks) and `catvton` (real model, below).
- **AI model used: CatVTON** ([Zheng-Chong/CatVTON](https://github.com/Zheng-Chong/CatVTON), ICLR 2025,
  899M total / 49.6M trainable parameters, SD1.5-inpainting backbone, CC BY-NC-SA — non-commercial). Chosen
  because its own README states under 8 GB VRAM at 1024x768, matching the user's card.
- **Measured, not claimed, on the user's actual RTX 2070 Super (8 GB):**
  - PyTorch 2.4.0+cu121 confirmed CUDA-usable on this GPU.
  - CatVTON loads and runs; GPU memory used ~3.3-5.7 GB during generation.
  - **~45-90 seconds per generated photo**, depending on steps (30 vs 50) — see 4.3 for the full timing history
    and why the number moved around.
  - At CatVTON's own demo defaults (50 steps, CFG/guidance_scale 5.0 — not its lower default of 2.5, see 4.3),
    output is a convincing photo of the user wearing the correct-coloured garment with hood/drawstring detail
    preserved.
  - A safety-filter bug (4.2) and a colour/steps bug (4.3) were found and fixed by direct testing, not by
    reading the README.
- Status: the full pipeline (drop -> countdown -> real AI photo -> garment cut-out -> live warp) was run
  end-to-end at least twice with real photos of the user and produced a plausible result each time. **Not yet
  polished**: garment cut-out from a very tight, chest-filling close-up photo can be jagged/incomplete (needs
  the person framed with shoulders+chest visible, which the on-screen countdown text asks for).

## 4. What was tried and abandoned or found not to work

### 4.1 Local, real-time, from-scratch 2D mesh warp of a plain product photo (superseded)
The first free-mode attempt: MediaPipe pose tracking + a hand-built triangle-mesh warp of the *raw product
photo* (no AI step at all) onto the body. User's verdict from real screenshots: looked like "a sticker on a
photo", flat and wrong. Superseded by the AI-keyframe approach in section 3.2, which uses a real generative
photo instead of stretching the flat product image. This code was removed from the extension.

### 4.2 CatVTON's stock safety filter — false positives, silent failure (found and fixed)
CatVTON's own `run_safety_checker` (a CLIP-based NSFW classifier from the SD1.5 pipeline it's built on) was
firing on ordinary, fully-clothed close-up portraits and **silently substituting a black "NSFW" placeholder
image with no error surfaced** — every close-up attempt was failing invisibly. Diagnosed by intercepting the
checker and inspecting the pre-filter image directly (it was a normal photo, not actually unsafe). **Fixed** by
replacing it with a purpose-built classifier, [Falconsai/nsfw_image_detection](https://huggingface.co/Falconsai/nsfw_image_detection)
(Apache-2.0, 343 MB, ViT-based), applied to both the garment image and the generated photo, with the filter
still on and a real error surfaced if it actually blocks something (HTTP 422, `code: "safety_filter"`).

### 4.3 Washed-out colour / lost garment detail at CatVTON's non-default settings (found and fixed)
First real generations came back with the garment's colour and texture washed out (a green ribbed hoodie
rendered as flat yellow or grey, no visible hood/drawstrings), even though the AI ran successfully and passed
the safety check. Root cause, found by testing against CatVTON's own demo (`app.py`) defaults: the server was
using `guidance_scale=2.5, steps=30`; CatVTON's own Gradio demo defaults to `guidance_scale=2.5` for its slider's
*starting* position but the demo's own markdown notes **"CFG is highly correlated with saturation"**, and its
slider range goes to 7.5. Direct A/B testing on the user's GPU with the same photo: CFG 2.5 -> flat, wrong
colour; **CFG 5.0 -> correct green colour, visible hood and drawstrings** (one hallucinated logo text
appeared — a known generative-model quirk, not investigated further). **Fixed**: server defaults changed to
`steps=50` (CatVTON's own demo default) and `guidance_scale=5.0`.

### 4.4 "Dense correspondence" (DensePose-class) real-time body tracking — researched, found infeasible right now
Proposed as a categorical upgrade over the 8-point MLS warp (dense per-pixel correspondence handles rotation and
self-occlusion far better than a sparse landmark warp; this is the reasoning behind published methods like
Pix2Surf, see 4.5). Checked two paths:
- **"Making DensePose fast and light"** ([arXiv:2006.15190](https://arxiv.org/abs/2006.15190), WACV 2021):
  17x smaller / 2x faster than baseline DensePose, 3.35M params, 4.3 MB quantized. Its own reported numbers:
  **~27 FPS on an Nvidia Tesla 1080Ti** (a discrete desktop GPU comparable to the user's card), but only
  **~1 FPS on mobile CPU**, and 0.5-2.4 FPS on mobile CPU across resolutions. **No code or pretrained weights
  were ever found publicly released** for this specific model (searched GitHub/academic mirrors directly) —
  confirmed dead end, not just "slow": there is nothing to download and run.
  There is also no evidence anyone has ported any DensePose variant to run via ONNX/WebGL/WebGPU in a browser at
  a usable frame rate; the 27 FPS number is native PyTorch/CUDA, not browser.
- Conclusion: **not viable as an in-browser, client-side component today.** The one un-abandoned idea from this
  line of research is 4.5 below, which runs natively (like the existing CatVTON server) instead of in the
  browser.

### 4.5 Pix2Surf-style garment texture transfer — real, released, but needs a missing subsystem
[Pix2Surf](https://github.com/JiahuiLei/Pix2Surf) ("Learning to Transfer Texture from Clothing Images to 3D
Humans", CVPR 2020, Max Planck Institute; a Windows-runnable fork exists at
[minar09/pix2surf_windows](https://github.com/minar09/pix2surf_windows)) is real, released PyTorch/GPU code
that learns dense pixel-to-garment-surface correspondence and renders in real time once that correspondence and
a 3D body pose are known. It maps a garment photo onto a **parametric SMPL body mesh** — it does not by itself
track a live person's pose from a webcam. Using it live requires *also* real-time 3D body-shape fitting from
video, a separate component (see section 5). Not abandoned — this is the current active lead — but not usable
on its own.

### 4.6 Other model candidates surveyed and ruled out for this hardware/goal
| Candidate | Why ruled out | Source |
|---|---|---|
| Tstars-Tryon 1.0 (Alibaba, 5B MMDiT, 3.92s/photo) | Benchmarked on an **H200** (~$30k datacenter GPU, 141 GB VRAM); industrial/Taobao-internal, no public weights | [arXiv:2604.19748](https://arxiv.org/abs/2604.19748) |
| MC-VTON (8-step distilled) | Built on **FLUX.1-dev, a 12B-parameter backbone** (13x CatVTON's size); no public code/weights found; independently, quantized FLUX on 8 GB VRAM measures 40-60+s/image in published benchmarks, i.e. fewer steps on a much bigger model nets similar or worse wall-clock time on this card | [arXiv:2501.03630](https://arxiv.org/abs/2501.03630); FLUX-on-8GB timing: [ComfyLab GGUF guide](https://comfylab.dev/blog/guides-pro/gguf-models-comfyui-run-flux-8gb-vram/) |
| LiveVVT (real-time *video* try-on, 22.4 FPS) | Trained on 8x A100; **no released code/weights found** | [arXiv:2608.26714](https://arxiv.org/abs/2608.26714) |
| Self-Forcing (real-time autoregressive video diffusion, open) | Officially supports 24 GB+ GPUs only; ~10 FPS on an RTX 4090 for the *base* video model, before any try-on-specific fine-tuning | [github.com/guandeh17/Self-Forcing](https://github.com/guandeh17/Self-Forcing) |
| StreamDiffusionV2 (serving stack, open) | A serving/scheduling layer, not a try-on model; needs a real-time base model (e.g. one of the above) to serve | [arXiv:2511.07399](https://arxiv.org/abs/2511.07399) |

### 4.7 Live pose tracking used for Free mode: MediaPipe Pose Landmarker + multiclass selfie segmentation
Not "abandoned" — this part works and is what Free mode uses today for live tracking and occlusion (arms/head
over the garment). Noted here because it is the direct alternative to 4.4/4.5's heavier body-mesh tracking: it
gives 33 sparse 2D landmarks at real browser frame rates (measured ~20-30 FPS in this project), but no dense
surface correspondence, which is the accuracy ceiling the current MLS warp is up against.

## 5. ROMP / SMPL body-mesh path: tried, then reverted

Chosen briefly (the user's "option 2"): drive garment placement with real-time monocular 3D body-mesh fitting
instead of 8 sparse landmarks.

- Candidate: [ROMP](https://github.com/Arthur151/ROMP) (`simple-romp`, ICCV 2021; BEV/CVPR22 and TRACE/CVPR23 in
  the same repo). README/community claim 30+ FPS on modern GPUs. **Never measured**: installation got as far as the
  package and the main `ROMP.pkl` weights, then stopped.
- Blocker: ROMP (like HMR2.0 and Pix2Surf's rendering step) needs the **SMPL body model file**
  (`SMPL_NEUTRAL.pkl`) from the Max Planck Institute, which is only distributed after registering an account and
  accepting a non-commercial research license at [smpl.is.tue.mpg.de](https://smpl.is.tue.mpg.de/).
- **Reverted at the user's request (2026-09-27)**: `simple-romp`, `lapx`, `Cython` uninstalled from the
  CatVTON venv, the `wget` package ROMP auto-installed into the global Python removed, and `~/.romp` (117 MB of
  weights and data) deleted. Nothing from this attempt was ever committed to the repo. The CatVTON environment is
  unaffected.
- Consequence: every SMPL-based upgrade (ROMP, HMR2.0, Pix2Surf) inherits the same license gate and the same
  non-commercial restriction. Any future dense-body approach should prefer a body model without that gate.

## 5b. Code review of the CatVTON integration (2026-09-27)

Prompted by the user's suspicion that CatVTON was "not implemented successfully". Verdict: the model **is** loaded
and run correctly (it produces a real try-on photo, see 3.2), but the integration around it has real defects that
explain the poor live result:

1. **No repaint outside the mask** (`server/tryon_server.py`): CatVTON ships `utils.repaint_result` (app.py
   `--repaint`) to paste the untouched person back outside the garment mask; the server skips it, so the whole
   frame drifts through the VAE (recoloured face, smeared background). The client's cut-out keys on "what changed",
   so it degrades to the coarse clothes class: the jagged collar-only sliver seen in the real run.
2. **Transparent garments become black**: `convert("RGB")` drops alpha without compositing on white.
3. **The server discards CatVTON's exact AutoMasker mask**, and the client re-guesses the garment from a 256 px
   selfie segmentation + a pixel diff. Returning the mask would remove both heuristics.
4. **Health check (2.5 s) falsely reports "offline" while the server is busy** (GIL held by generation).
5. **Cancelled keyframes keep the GPU busy ~80 s** (no server-side cancel), so a new garment can wait ~160 s.
6. **No fixed seed**, so keyframes in the pose bank show different garments and pop when cross-fading.
7. steps/seed/guidance not validated before GPU work; result resize stretches instead of undoing the crop;
   UI still says 15-45 s (measured 77-90 s at 50 steps); duplicated guidance defaults.

## 5c. Mobile-VTON (second opinion, supplied by the user)

A separate review compared Mobile-VTON with CatVTON. Summary of its conclusions: Mobile-VTON's paper reports about
80 s per 1024x768 image on a mobile NPU with an INT8 deployment (not live, no RTX 2070 Super timing); lower published
memory (2.84 GB vs 5.80 GB in its CatVTON comparison); mixed quality vs CatVTON (better LPIPS, worse SSIM/CLIP-I on
the authors' in-the-wild set); released inference defaults to BF16 with multi-process batches, which Turing (RTX 20,
compute capability 7.5) lacks natively, and an FP16 path that is not shown to be validated; authors note weakness on
garment text/logos. Recommendation adopted here: keep CatVTON as the baseline; Mobile-VTON is at most a
side-by-side keyframe experiment (same photo + garment, record peak VRAM, time, colour/detail fidelity, cut-out
cleanliness), and neither model makes the result live on its own.

## 6. Honest assessment of the "genuinely new" ask

The user asked for something nobody but a capable model could figure out, comparable to breakthroughs like
LLaMA or JEPA. Stated plainly: that kind of result comes from research teams running months of compute and
experiments, most of which fail before one works, and is not something producible by reasoning alone in a chat
session. What this investigation did instead, and what it is worth: found that the technically correct
architectural upgrade (dense body correspondence instead of sparse landmarks) is a known, cited idea in the
literature (Pix2Surf, 2020), verified which of the candidate implementations of it are actually real and
downloadable versus paper-only claims (DensePose-lite: paper-only, dead end; ROMP: real but gated behind the SMPL
license, reverted; Pix2Surf: real but needs the same SMPL file plus a live-fitting component), and ruled out three other model families with concrete, sourced numbers rather than assumptions.
That is the honest scope of "research" performed here: verification and synthesis of real, cited work, not
invention of new fundamental methods.

## 7. Full reference list

- Decart Lucy V-TON docs: https://docs.platform.decart.ai/models/realtime/virtual-try-on
- Anywear: https://anywear.decart.ai/
- Decart Lucy / MirageLSD blog: https://decart.ai/blog
- CatVTON: https://github.com/Zheng-Chong/CatVTON (ICLR 2025)
- Falconsai/nsfw_image_detection: https://huggingface.co/Falconsai/nsfw_image_detection
- "Making DensePose fast and light": https://arxiv.org/abs/2006.15190 (WACV 2021)
- Pix2Surf (clothing-to-3D-human texture transfer): https://github.com/JiahuiLei/Pix2Surf ,
  Windows fork: https://github.com/minar09/pix2surf_windows (CVPR 2020)
- ROMP / BEV / TRACE: https://github.com/Arthur151/ROMP (ICCV21 / CVPR22 / CVPR23) (tried and reverted, section 5)
- CatVTON repaint helper: `repaint_result` in https://github.com/Zheng-Chong/CatVTON/blob/main/utils.py
- SMPL body model (registration required): https://smpl.is.tue.mpg.de/
- Tstars-Tryon 1.0: https://arxiv.org/abs/2604.19748
- MC-VTON: https://arxiv.org/abs/2501.03630
- FLUX on 8GB VRAM timing: https://comfylab.dev/blog/guides-pro/gguf-models-comfyui-run-flux-8gb-vram/
- LiveVVT: https://arxiv.org/abs/2608.26714
- Self-Forcing: https://github.com/guandeh17/Self-Forcing
- StreamDiffusionV2: https://arxiv.org/abs/2511.07399
- Earlier, broader survey (LiveVVT, GS-VTON, PF-AFN, etc.): see [ROADMAP-free-tryon.md](ROADMAP-free-tryon.md)
  section 2 and its own reference list.
