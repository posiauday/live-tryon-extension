# Local try-on server (for Free mode)

The extension's **Free** mode asks this small server, running on your own PC, for one AI photo of you wearing the garment
(the "keyframe"). Nothing leaves your machine and nothing is billed. The extension then tracks you live in the browser.

```
extension (Chrome)  --POST /tryon {person, garment, category}-->  server/tryon_server.py  -->  CatVTON on your GPU
                    <--{image}-----------------------------------
```

## 1. Check the wiring first (no GPU, no downloads)

```
python server/tryon_server.py
```
Leave it running, open the extension, choose **Free**: the card should say **Online · mock**. The mock engine pastes a
scaled copy of the garment onto the photo, so you can see the whole flow (countdown, keyframe, live tracking) without any model.
(Install Pillow with `pip install pillow` if you want the mock to actually paste the garment.)

## 2. Real AI: CatVTON (about 8 GB GPU)

Tested target: an NVIDIA GPU with 8 GB, e.g. RTX 2070 Super. **These steps and `--engine catvton` have not been run on real
weights by the author yet**: the first run is a test. Expect several GB of downloads (PyTorch, the CatVTON weights, the Stable
Diffusion inpainting base model, DensePose and SCHP), so keep 15 GB free.

```
python -m venv .venv-tryon
.venv-tryon\Scripts\activate
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu121
git clone https://github.com/Zheng-Chong/CatVTON.git ../CatVTON
pip install -r ../CatVTON/requirements.txt
python server/tryon_server.py --engine catvton --catvton-dir ../CatVTON --precision fp16
```

* `--precision fp16` is right for RTX 20-series (no bf16). On RTX 30/40 you may use `--precision bf16`.
* First start downloads the weights, then prints `listening on http://127.0.0.1:7861`.
* Each photo takes roughly 15-45 s on an 8 GB card (measure it, then tell the extension's users what to expect).
* Out of memory? Close other GPU apps, turn off Chrome hardware acceleration while generating, or pass `steps` lower in the request.
* CatVTON is released under CC BY-NC-SA 4.0: personal / non-commercial use only.

## API

`GET /health` -> `{"ok": true, "engine": "catvton", "cuda": "...", "vram_gb": 8.0, "busy": false}`

`POST /tryon` with JSON
`{"person": "data:image/png;base64,...", "garment": "data:image/...", "category": "upper|lower|overall", "steps": 30, "seed": 42}`
-> `{"image": "data:image/png;base64,...", "seconds": 21.4, "engine": "catvton"}`

The person photo is a 3:4 portrait crop (768x1024) around your torso; the result has the same size and is pixel-aligned with it,
which is what lets the extension cut the garment out and warp it onto you.

## Security

The server binds to `127.0.0.1` only. It answers CORS with `*` so the extension page can call it; any website you visit could
therefore also send it images and use your GPU. It returns nothing private. Use `--allow-origin chrome-extension://<your-id>`
to lock it to the extension.
