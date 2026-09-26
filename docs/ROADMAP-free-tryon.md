# Roadmap: a (nearly) free live try-on, 6/10 now, 8/10 next, 9-10 later

Status: research + plan, written September 2026. Nothing here is built yet except the paid Decart "AI Live" mode.
Anything I could not verify is marked **(unverified)**. Ideas that are mine and not from a paper are marked **(hypothesis)**.

## 1. Verdict

* A free, on-device **6/10** live try-on is realistic: one AI-generated keyframe of you wearing the garment, then tracked and
  warped live. It will look like a good sticker-on-a-photo, not like Decart.
* **8/10 is reachable for a narrow case** (front-facing tops, small movements) without paying per second, by turning the
  keyframe into a small *video-codec-like* system: AI "I-frames", optical-flow "P-frames", relighting, and a bank of keyframes
  for different poses. This is engineering plus a few real research bets, not magic.
* **9-10/10 live, on any body movement, for pennies** needs a real-time video try-on model. The science exists (LiveVVT,
  Aug 2026, 22 FPS) but I found **no released weights**. Building one is a funded training project, not a weekend.
* "Free" has two meanings. Free for the *user's wallet* is possible with the user's own GPU (photo/keyframe work only). Free
  *compute* for live diffusion does not exist: someone owns a GPU. The realistic best case is roughly **100x cheaper than
  Decart**, not zero (section 3).

## 2. What the research actually says

| Work | What it shows | Speed / hardware | Open? | Use for us |
|---|---|---|---|---|
| **LiveVVT** (arXiv 2608.26714, Aug 2026) | Real-time *video* try-on. Rolling streaming diffusion, 4 denoising steps, a **persistent garment appearance memory built once from the garment plus a frontal try-on keyframe**, plus a short-term memory for recent motion and occlusion. Conditioned on inpainting mask + DensePose + garment-agnostic person image. | 22.39 FPS sustained, 1.56 s first-chunk latency, 512x384, 1.3B params (from Wan2.1-Fun-1.3B-Control), trained on 8x A100. GPU used for the FPS figure: not stated in what I read. | No code or weights found **(unverified)** | The blueprint for the 9-10 tier. Its "keyframe + persistent appearance" idea is exactly our hybrid. Known failure modes: strong lighting change, self-occlusion, extreme articulation, large out-of-plane rotation. |
| **Self-Forcing** (NeurIPS 2025) | Autoregressive video diffusion on Wan 1.3B. | 17 FPS on one H100; about 10 FPS at 480p on an RTX 4090; officially supported hardware is 24 GB+ | Yes | Real-time open base to distill a try-on model into (9-10 tier). Not for an 8 GB laptop. |
| **StreamDiffusionV2** (MLSys 2026) | Training-free live streaming system for video diffusion, pip installable, webcam demo. | 64.5 FPS with a 1.3B model on high-end multi-GPU setups | Yes | Serving stack for a cloud tier. |
| **StreamDiffusion** (image) | Real-time img2img. | about 91 FPS img2img on an RTX 4090 with SD-Turbo | Yes | Shows per-frame diffusion is possible on consumer GPUs, but only with weak garment fidelity. |
| **Tstars-Tryon 1.0** (arXiv 2604.19748) | Distilled 5B DiT image try-on (CFG + step distillation). | 3.9 s per single-garment image (GPU not stated) | Not confirmed | Shows the keyframe step can get to a few seconds on strong hardware. |
| **MagicTryOn-Turbo / CatV2TON** | Open video try-on. | MagicTryOn-Turbo: 64 frames at 624x832 in 6.7 s on one H20 GPU | Yes | Offline video, not live. Good teacher models. |
| **CatVTON / IDM-VTON / Leffa** | Open image try-on. | seconds to tens of seconds on 8 GB; CatVTON states under 8 GB VRAM at 1024x768 | Yes, non-commercial licenses | The keyframe generator for the 6/10 tier. |
| **Dress-1-to-3, Garment3DGen** | Single image to simulation-ready 3D garment. | Offline, minutes | Papers/code vary | A far-future 3D path. Too slow and fragile for live. |
| **GS-VTON** | 3D Gaussian-splat try-on. | Needs multi-view images of the person and per-scene optimization | Yes | Not viable for a webcam. |
| **PF-AFN / FW-GAN** (2019-2021) | Feed-forward warp + generator try-on; FW-GAN is video. | Fast, older | Yes | Lower quality than diffusion; useful only as a speed reference. |
| **Decart Lucy / MirageLSD** | Pure diffusion, autoregressive with Diffusion Forcing and self-anchoring, under 40 ms at 720p on Hopper GPUs. | Their own inference stack | No | The commercial benchmark we are trying to approach. |

Take-away: the two ideas that matter are (a) LiveVVT's "keyframe + persistent appearance memory" and (b) that a 1.3B few-step
streaming model can hit 20+ FPS on datacenter GPUs. Neither runs on an 8 GB laptop today.

## 3. Cost math (rough)

* Decart: about $0.02 per second, so about **$1.20 per minute**.
* Rented RTX 4090: about $0.34 to $0.69 per hour (RunPod / Modal, Sept 2026 listings) which is about **$0.006 to $0.012 per
  minute** of a dedicated GPU. A self-hosted real-time model at about 10 FPS on one 4090 is therefore ~100x cheaper per
  user-minute than Decart, if we had the model and one GPU per active user.
* Your own laptop: $0 in cash, but photo-speed only (seconds per image), and heat.

## 4. Target architecture: "I-frames and P-frames" for clothing (hypothesis, from video codecs)

```
   slow AI (seconds)                          fast, cheap, on-device (30+ FPS in the browser)
 +------------------------+                 +---------------------------------------------+
 | keyframe generator     |  I-frame        | pose + person masks (MediaPipe)             |
 | (CatVTON / IDM-VTON on |---------------->| garment layer = mask cut out of the I-frame|
 | your GPU, or cloud)    |  garment RGBA   | warp to live body: mesh now, dense flow later|
 +-----------^------------+  + normals      | relight + shadow + occlusion (arms in front) |
             | refresh when drift > limit    | composite over the live video               |
             +-------------------------------+---------------------------------------------+
```

The AI only runs when the tracker says "the current keyframe no longer matches you" (big rotation, large pose change,
lighting jump) or once at the start. Everything per-frame is cheap graphics.

## 5. Tier 6/10: "Keyframe + Warp" (build first)

Exit criteria (measured, see section 8): for a front-facing top, small movements (about +/-15 degrees, arms down), the garment
stays aligned to the shoulders and torso within about 3% of shoulder width, no visible jitter, arms drawn in front of it,
brightness matches; user rates it 6 or more out of 10 next to Decart on the same clip.

| Step | What | Notes / risk | Effort |
|---|---|---|---|
| 0 | **Manual quality check, no code**: make one try-on photo with any tool, decide if the source quality is good enough | Gate. Cheap. | 30 min (you) |
| 1 | **Photo backend adapter**: local server (ComfyUI or CatVTON web app) on `127.0.0.1`; the extension talks to it with a host permission; adapter interface so backends can be swapped (later: cloud GPU) | Needs a real GPU run to validate. Cannot be tested by me with real models. | 1-2 days |
| 2 | **Snapshot flow**: 3-2-1 countdown, capture one still, send with the dropped garment, progress + cancel, "Back to camera" | Reuses the panel and drop zone. | 1 day |
| 3 | **Garment extraction**: segment the "clothes" pixels of the returned image (multiclass segmenter) to get an RGBA garment layer; also keep the person's sleeves/arms separate | Segmenter errors at collars and hems are the main visible flaw. | 1-2 days |
| 4 | **Live tracker**: MediaPipe pose (shoulders, hips, elbows) with One Euro smoothing, person mask for occlusion. **Restore the old mesh-warp and spring-cloth code from git history (commit 76b0c6d).** | The same warp that looked bad with a flat product photo; the new texture is already fitted to your body, so this should look far better. | 1-2 days |
| 5 | **Composite**: brightness match, soft shadow, arms/hands/hair over the garment, seam feathering | | 1 day |
| 6 | **Face/pose gate before the snapshot** (tiny detector, about 200 KB) so we never spend 30 s on an empty room | | 0.5 day |
| 7 | **Benchmark harness** (section 8) | Needed to know we improved. | 1 day |

Cheap de-risking spike before steps 1-3 (about 1 hour): take one AI try-on photo from any free tool, hand-cut the garment, load it
into the restored warp code, and move in front of the camera. If that already looks acceptable, the whole tier is safe.

## 6. From 6 to 7 and 8 (the research bets)

Each item has an experiment and a stop rule, because some of these will not work.

**7/10, mostly engineering**
1. **Flow propagation instead of a rigid warp (EbSynth-style)**. Track dense motion on the torso with a small optical-flow net
   (RAFT-small class, run through ONNX Runtime Web / WebGPU) and propagate the keyframe's garment pixels along it, so
   wrinkles and hems move with the body instead of sliding. Test: flicker and edge error vs the mesh warp on the benchmark. Stop if
   it cannot hold 15 FPS in the browser.
2. **Relighting (hypothesis)**. From the keyframe, estimate normals and albedo (a monocular normal model), estimate a coarse light
   probe from the live face/background each second, and re-shade the garment in WebGL. This attacks the "frozen shading" flaw.
3. **Edge harmonizer**. A very small U-Net (a few MB, 256x256) that repairs the seam between garment, skin and hair, trained on
   synthetic composites. Cheap and directly visible.

**8/10, real research**
4. **Pose-indexed keyframe bank (hypothesis)**. While you hold still for about 10 seconds the app captures a few poses (front, slightly
   left/right, arms slightly raised), generates a keyframe for each in the background (minutes of GPU, free on your PC), then at
   runtime picks the nearest two keyframes by pose and blends them. Handles rotation and arm changes without a wait. Risk: keyframes
   disagree on texture, causing flicker. Mitigation: share the garment latent/seed, temporal smoothing, blend by pose distance.
5. **Personalized real-time student (hypothesis, test-time distillation)**. Use the slow model as a *teacher* on 20 to 40 frames of *this*
   person in *this* garment, then overfit a tiny image-to-image network (2 to 5M parameters) to reproduce it from body parsing +
   live frame, in minutes, on the local GPU. Overfitting to one person and one garment is the point, the same trick used for per-scene
   neural rendering. Runs at 30+ FPS in the browser. Stop rule: if 20 teacher frames are not enough to keep quality outside the captured poses,
   or training takes more than about 10 minutes on an 8 GB laptop, drop it.
6. **Dense body mapping**. Replace 33 landmarks with SMPL/DensePose-style UV mapping so the garment follows torso twist and depth,
   not just a 2D quad. DensePose is heavy for a browser; a distilled dense-UV net would be a small project of its own.

## 7. 9-10/10: a real-time try-on model (LiveVVT-class), cloud, about 100x cheaper than Decart

Ingredients that are open: **Wan2.1-Fun-1.3B-Control** (base), **Self-Forcing** distillation code, **StreamDiffusionV2** serving stack,
public video try-on datasets (ViViD, VVT) and open teachers (CatV2TON, MagicTryOn). Missing: LiveVVT's weights **(unverified)**.

Plan: (1) fine-tune a bidirectional 1.3B try-on model on public data (mask + DensePose + garment conditioning), (2) distill to 4 steps
with a Self-Forcing-style rollout and add a persistent garment/keyframe memory, (3) serve on rented 4090s with StreamDiffusionV2.
The paper trained on 8x A100; my rough guess is on the order of $1k to $5k of GPU time plus weeks of iteration **(hypothesis, not
from the paper)**. Honest options: do it as a funded project, wait for LiveVVT-class weights, or stay on Decart for the live mode and use the
hybrid above as the free mode.

## 8. How we will know it is 6, 8, or 10 (benchmark)

Record five 20-second clips once (stand still; slow sway; raise arms; turn about 30 degrees; lean toward the camera), with three
garments (plain tee, patterned tee, jacket). For each mode compute and record: temporal flicker (frame-to-frame difference inside
the garment mask), edge error (mask vs a hand-marked garment outline on 10 frames), latency, and a blind 1-10 rating by two or
more people, with Decart's output on the same clips as the reference score. Levels: **6** = passes the exit criteria in section 5;
**8** = within 1.5 points of Decart on still, sway and arms-raised clips; **10** = ties Decart on all five.

## 9. Risks and unknowns (be skeptical of me too)

* I have not run any backend. Every speed number for your 8 GB laptop is a guess until step 0.
* CatVTON and IDM-VTON licenses are non-commercial. Fine for a personal project, blocking for a product.
* Photo backends must run beside Chrome; Chrome takes a few hundred MB of GPU memory. Expect heat and slowdowns.
* 2D warping cannot show the back of a garment. Rotation beyond about 35 degrees needs a new keyframe or a keyframe bank.
* Hoods, pants, dresses, layered clothes and long sleeves over your real arms are the hardest cases; expect the 6/10 tier to be for tops.
* The 7 and 8 items are bets. The stop rules exist so a failed bet costs days, not weeks.

## 10. Decisions needed

1. Backend for the keyframe: CatVTON (lightest, my pick) or ComfyUI with IDM-VTON.
2. Do the 1-hour spike first (recommended), or go straight to step 1?
3. Is a cloud GPU acceptable for the 9-10 tier later (about $0.01 per minute), or must everything run on your PC?

## Sources

* LiveVVT: https://arxiv.org/abs/2608.26714
* Self-Forcing: https://arxiv.org/abs/2506.08009 and https://github.com/guandeh17/Self-Forcing
* StreamDiffusionV2: https://arxiv.org/abs/2511.07399 and https://github.com/chenfengxu714/StreamDiffusionV2
* StreamDiffusion: https://github.com/cumulo-autumn/StreamDiffusion
* Tstars-Tryon 1.0: https://arxiv.org/pdf/2604.19748
* MagicTryOn: https://arxiv.org/abs/2505.21325 , CatV2TON: https://github.com/Zheng-Chong/CatV2TON
* CatVTON: https://github.com/Zheng-Chong/CatVTON , Awesome-Try-On-Models: https://github.com/Zheng-Chong/Awesome-Try-On-Models
* Dress-1-to-3: https://arxiv.org/abs/2502.03449 , GS-VTON: https://arxiv.org/abs/2410.05259
* PF-AFN: https://arxiv.org/abs/2103.04559 , FW-GAN (ICCV 2019)
* Decart Lucy / MirageLSD: https://decart.ai/blog
* GPU prices: https://www.runpod.io/gpu-models/rtx-4090 , https://getdeploying.com/gpus/nvidia-rtx-4090
