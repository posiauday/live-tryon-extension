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

## 5. Where the investigation is right now (open, blocked on the user)

Chosen path (per the user's explicit choice of "option 2" over patching the existing warp further): build
real-time monocular 3D body-mesh fitting to drive garment placement, instead of 8 sparse landmarks.

- **Candidate found and installed**: [ROMP](https://github.com/Arthur151/ROMP) (`simple-romp` on PyPI;
  ICCV 2021, plus its successors BEV/CVPR22 and TRACE/CVPR23 in the same repo). Actively maintained, ONNX
  export available, built-in webcam demo with temporal tracking. Its README/community claims **30+ FPS on
  modern GPUs**, 5-10 FPS on CPU — **not yet independently verified by me**, which is the whole point of the
  current step: measure it directly rather than trust the number.
- **Installed on the user's machine**: `simple-romp` (via pip, with Cython + `--no-build-isolation`), its main
  model weights (`ROMP.pkl`, downloaded directly from the GitHub release), and its freely-downloadable auxiliary
  data (`smpl_model_data.zip`: J-regressors, kid template).
- **Blocked on**: ROMP requires Meta/MPI's **SMPL body model file** (`SMPL_NEUTRAL.pkl`), which is gated behind
  free registration and a click-through non-commercial research license at
  [smpl.is.tue.mpg.de](https://smpl.is.tue.mpg.de/). This is a real, standard requirement of the SMPL license
  (every SMPL-based project — ROMP, HMR2.0, Pix2Surf's rendering step — needs the same file the same way), not
  a workaround-able technical limit, and creating accounts is something the user needs to do, not me.
- **Immediate next step once the file is provided**: run `romp.prepare_smpl`, then a direct, repeated-inference
  benchmark script (already written) on the user's real webcam photo, on the RTX 2070 Super, to get a genuine
  measured FPS number before any further integration work.
- **Not yet investigated at all**: whether ROMP's pose/shape output is accurate and stable enough (per-frame
  jitter, failure on partial-body/close-up frames) to actually hang a garment mesh on — speed is necessary but
  not sufficient; accuracy is the next question after speed.
- **Also not yet investigated**: how a Pix2Surf-style texture-transfer step would be driven by ROMP's live SMPL
  output in practice (this is genuine integration engineering, not just wiring — the two projects were not built
  to talk to each other).

## 6. Honest assessment of the "genuinely new" ask

The user asked for something nobody but a capable model could figure out, comparable to breakthroughs like
LLaMA or JEPA. Stated plainly: that kind of result comes from research teams running months of compute and
experiments, most of which fail before one works, and is not something producible by reasoning alone in a chat
session. What this investigation did instead, and what it is worth: found that the technically correct
architectural upgrade (dense body correspondence instead of sparse landmarks) is a known, cited idea in the
literature (Pix2Surf, 2020), verified which of the candidate implementations of it are actually real and
downloadable versus paper-only claims (DensePose-lite: paper-only, dead end; ROMP: real, downloaded, pending one
license file; Pix2Surf: real, downloaded conceptually but needs the same missing SMPL piece plus a live-fitting
component), and ruled out three other model families with concrete, sourced numbers rather than assumptions.
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
- ROMP / BEV / TRACE: https://github.com/Arthur151/ROMP (ICCV21 / CVPR22 / CVPR23)
- SMPL body model (registration required): https://smpl.is.tue.mpg.de/
- Tstars-Tryon 1.0: https://arxiv.org/abs/2604.19748
- MC-VTON: https://arxiv.org/abs/2501.03630
- FLUX on 8GB VRAM timing: https://comfylab.dev/blog/guides-pro/gguf-models-comfyui-run-flux-8gb-vram/
- LiveVVT: https://arxiv.org/abs/2608.26714
- Self-Forcing: https://github.com/guandeh17/Self-Forcing
- StreamDiffusionV2: https://arxiv.org/abs/2511.07399
- Earlier, broader survey (LiveVVT, GS-VTON, PF-AFN, etc.): see [ROADMAP-free-tryon.md](ROADMAP-free-tryon.md)
  section 2 and its own reference list.
