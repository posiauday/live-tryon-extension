#!/usr/bin/env python3
"""Local try-on server for the extension's Free mode.

    GET  /health -> {"ok": true, "engine": "...", "gpu": "..."}
    POST /tryon  {"person": dataURL, "garment": dataURL, "category": "upper|lower|overall", "steps": 30, "seed": 42}
                 -> {"image": dataURL, "seconds": 12.3, "engine": "..."}

Engines
    mock      no AI: pastes a scaled copy of the garment on the torso. For checking the wiring without a GPU.
    catvton   CatVTON (https://github.com/Zheng-Chong/CatVTON), fp16, fits an 8 GB GPU (about 45 s per photo on an RTX 2070 Super).
              Safety: the garment you drop and the photo it generates are both checked by an image-safety classifier.

Only the standard library is required for the mock engine (Pillow optional). Binds to 127.0.0.1 by default: your photos never
leave the machine.
"""
import argparse
import base64
import io
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_BODY = 60 * 1024 * 1024


class SafetyFiltered(Exception):
    """The AI safety filter rejected the generated photo."""
GPU_LOCK = threading.Lock()  # one generation at a time


def data_url_to_bytes(url):
    if not isinstance(url, str) or "," not in url:
        raise ValueError("expected an image data URL")
    return base64.b64decode(url.split(",", 1)[1])


def png_data_url(image):
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


class MockEngine:
    name = "mock"

    def __init__(self):
        try:
            from PIL import Image  # noqa: F401
            self.pil = True
        except ImportError:
            self.pil = False

    def info(self):
        return {"pillow": self.pil}

    def generate(self, person, garment, category, steps, seed, guidance_scale=2.5):
        if not self.pil:  # no Pillow: hand the person photo back unchanged
            return person
        from PIL import Image
        p = Image.open(io.BytesIO(person)).convert("RGB")
        g = Image.open(io.BytesIO(garment)).convert("RGBA")
        w, h = p.size
        # product photos usually sit on a white background: make near-white pixels transparent, then crop to the garment
        px = g.load()
        for y in range(g.height):
            for x in range(g.width):
                r, gr, b, a = px[x, y]
                if a > 0 and min(r, gr, b) > 235:
                    px[x, y] = (r, gr, b, 0)
        bbox = g.getchannel("A").getbbox()
        if bbox:
            g = g.crop(bbox)
        box = {"upper": (0.10, 0.28, 0.90, 0.80), "lower": (0.15, 0.55, 0.85, 1.0), "overall": (0.10, 0.28, 0.90, 1.0)}.get(category, (0.10, 0.28, 0.90, 0.80))
        x0, y0, x1, y1 = int(w * box[0]), int(h * box[1]), int(w * box[2]), int(h * box[3])
        scale = min((x1 - x0) / g.width, (y1 - y0) / g.height)  # keep the garment's proportions
        g = g.resize((max(1, int(g.width * scale)), max(1, int(g.height * scale))))
        p.paste(g, (x0 + ((x1 - x0) - g.width) // 2, y0), g)
        out = io.BytesIO()
        p.save(out, format="PNG")
        return out.getvalue()


class SafetyClassifier:
    """Image-safety classifier (Falconsai/nsfw_image_detection, Apache-2.0, ViT). Replaces CatVTON's stock CLIP filter,
    which wrongly blocks close-up portraits. Applied to the garment image that comes in and to the photo that goes out."""

    REPO = "Falconsai/nsfw_image_detection"

    def __init__(self, device="cuda", threshold=0.5):
        import torch
        from huggingface_hub import snapshot_download
        from transformers import AutoModelForImageClassification, ViTImageProcessor
        path = snapshot_download(self.REPO, allow_patterns=["config.json", "preprocessor_config.json", "model.safetensors"])
        self.torch, self.device, self.threshold = torch, device, threshold
        self.processor = ViTImageProcessor.from_pretrained(path)
        self.model = AutoModelForImageClassification.from_pretrained(path).to(device).eval()
        self.nsfw_index = next(i for i, name in self.model.config.id2label.items() if str(name).lower() == "nsfw")

    def nsfw_score(self, image):
        torch = self.torch
        with torch.no_grad():
            inputs = self.processor(images=image.convert("RGB"), return_tensors="pt").to(self.device)
            probs = torch.softmax(self.model(**inputs).logits, dim=-1)[0]
        return float(probs[int(self.nsfw_index)])

    def check(self, image, what):
        score = self.nsfw_score(image)
        print("[safety] %s: nsfw score %.3f (blocked at %.2f)" % (what, score, self.threshold), flush=True)
        if score >= self.threshold:
            raise SafetyFiltered("The safety check blocked the %s. Try a different image, or sit back so your shoulders and chest are in view." % what)


class CatVTONEngine:
    """CatVTON on the local GPU. Mirrors CatVTON's own app.py (model loading, AutoMasker, pipeline call)."""

    name = "catvton"

    def __init__(self, catvton_dir, precision="fp16", width=768, height=1024, base_model="booksforcharlie/stable-diffusion-inpainting", resume="zhengchong/CatVTON"):
        sys.path.insert(0, catvton_dir)
        import os
        import torch
        from diffusers.image_processor import VaeImageProcessor
        from huggingface_hub import snapshot_download
        from model.cloth_masker import AutoMasker
        from model.pipeline import CatVTONPipeline
        from utils import init_weight_dtype, resize_and_crop, resize_and_padding

        self.torch, self.width, self.height = torch, width, height
        self.resize_and_crop, self.resize_and_padding = resize_and_crop, resize_and_padding
        repo_path = snapshot_download(repo_id=resume)
        self.pipeline = CatVTONPipeline(
            base_ckpt=base_model, attn_ckpt=repo_path, attn_ckpt_version="mix",
            weight_dtype=init_weight_dtype(precision), use_tf32=True, device="cuda",
            skip_safety_check=True,  # replaced by SafetyClassifier below (not removed)
        )
        self.mask_processor = VaeImageProcessor(vae_scale_factor=8, do_normalize=False, do_binarize=True, do_convert_grayscale=True)
        self.automasker = AutoMasker(densepose_ckpt=os.path.join(repo_path, "DensePose"), schp_ckpt=os.path.join(repo_path, "SCHP"), device="cuda")
        self.safety = SafetyClassifier()  # loads a small (343 MB) classifier; see the class docstring

    def info(self):
        return {"cuda": self.torch.cuda.get_device_name(0), "vram_gb": round(self.torch.cuda.get_device_properties(0).total_memory / 1e9, 1)}

    def generate(self, person, garment, category, steps, seed, guidance_scale=5.0):
        from PIL import Image
        torch = self.torch
        p = Image.open(io.BytesIO(person)).convert("RGB")
        g = Image.open(io.BytesIO(garment)).convert("RGB")
        orig_size = p.size
        self.safety.check(g, "garment image")
        p = self.resize_and_crop(p, (self.width, self.height))
        g = self.resize_and_padding(g, (self.width, self.height))
        mask = self.automasker(p, {"upper": "upper", "lower": "lower", "overall": "overall"}.get(category, "upper"))["mask"]
        mask = self.mask_processor.blur(mask, blur_factor=9)
        generator = torch.Generator(device="cuda").manual_seed(int(seed)) if seed is not None and int(seed) != -1 else None
        result = self.pipeline(image=p, condition_image=g, mask=mask, num_inference_steps=int(steps or 50), guidance_scale=guidance_scale, generator=generator)[0]
        torch.cuda.empty_cache()
        self.safety.check(result, "generated photo")
        if result.size != orig_size:
            result = result.resize(orig_size)
        out = io.BytesIO()
        result.save(out, format="PNG")
        return out.getvalue()


def make_handler(engine, allow_origin):
    class Handler(BaseHTTPRequestHandler):
        server_version = "TryOnServer/1"

        def log_message(self, fmt, *args):  # quieter: one line per request
            sys.stderr.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

        def _cors(self):
            self.send_header("Access-Control-Allow-Origin", allow_origin)
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Access-Control-Max-Age", "600")

        def _json(self, status, payload):
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self):
            self.send_response(204)
            self._cors()
            self.end_headers()

        def do_GET(self):
            if self.path.split("?")[0] == "/health":
                self._json(200, {"ok": True, "engine": engine.name, "busy": GPU_LOCK.locked(), **engine.info()})
            else:
                self._json(404, {"error": "not found"})

        def do_POST(self):
            if self.path.split("?")[0] != "/tryon":
                return self._json(404, {"error": "not found"})
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length <= 0 or length > MAX_BODY:
                    return self._json(413, {"error": "request too large or empty"})
                req = json.loads(self.rfile.read(length))
                person, garment = data_url_to_bytes(req.get("person")), data_url_to_bytes(req.get("garment"))
                category = req.get("category", "upper")
                if category not in ("upper", "lower", "overall"):
                    return self._json(400, {"error": "category must be upper, lower or overall"})
            except Exception as error:  # bad request
                return self._json(400, {"error": "bad request: %s" % error})
            t0 = time.time()
            try:
                with GPU_LOCK:
                    png = engine.generate(person, garment, category, req.get("steps"), req.get("seed"), req.get("guidance_scale", 5.0))
            except SafetyFiltered as error:
                return self._json(422, {"error": str(error), "code": "safety_filter"})
            except Exception as error:  # e.g. CUDA out of memory
                msg = str(error)
                if "out of memory" in msg.lower():
                    msg = "The GPU ran out of memory. Close other GPU apps (or Chrome tabs) and try again, or lower the steps."
                return self._json(500, {"error": msg})
            self._json(200, {"image": "data:image/png;base64," + base64.b64encode(png).decode("ascii"), "seconds": round(time.time() - t0, 2), "engine": engine.name})

    return Handler


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--engine", choices=["mock", "catvton"], default="mock")
    ap.add_argument("--host", default="127.0.0.1", help="keep 127.0.0.1 unless you know why not")
    ap.add_argument("--port", type=int, default=7861)
    ap.add_argument("--catvton-dir", help="path to a clone of https://github.com/Zheng-Chong/CatVTON")
    ap.add_argument("--precision", choices=["fp16", "bf16", "no"], default="fp16", help="fp16 for RTX 20-series (no bf16); bf16 on RTX 30/40")
    ap.add_argument("--allow-origin", default="*", help="CORS origin (the extension page calls this server from chrome-extension://...)")
    args = ap.parse_args()

    if args.engine == "catvton":
        if not args.catvton_dir:
            ap.error("--engine catvton needs --catvton-dir")
        print("Loading CatVTON (first run downloads the model weights; this can take several minutes)...", flush=True)
        engine = CatVTONEngine(args.catvton_dir, precision=args.precision)
    else:
        engine = MockEngine()
    httpd = ThreadingHTTPServer((args.host, args.port), make_handler(engine, args.allow_origin))
    print("Try-on server (%s) listening on http://%s:%d  (Ctrl+C to stop)" % (engine.name, args.host, args.port), flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("bye")


if __name__ == "__main__":
    main()
