#!/usr/bin/env python3
"""Tool Vision local print connector — bridges the web app (HTTP) to the QL-800 (CUPS).
Both the browser app and the terminal print through the same CUPS queue, so they never fight
over the USB device (no WebUSB needed). Listens on 127.0.0.1:17777."""
import json, subprocess, tempfile, os, datetime, base64, io
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from PIL import Image as _I, ImageDraw, ImageFont
if not hasattr(_I, "ANTIALIAS"): _I.ANTIALIAS = _I.Resampling.LANCZOS
# Cap decoded-image pixels to defuse decompression bombs (a 62mm label is ~696×~1000 px).
_I.MAX_IMAGE_PIXELS = 4_000_000
from brother_ql.raster import BrotherQLRaster
from brother_ql.conversion import convert

QUEUE = "ToolVision_QL800"
PORT = 17777
MAX_BODY = 8 * 1024 * 1024  # 8 MB — a label PNG is a few KB; reject anything larger.

def _origin_ok(origin: str) -> bool:
    """Only the Tool Vision app (prod, its preview deploys, or local dev) may drive the printer —
    not any random site the user happens to visit."""
    if not origin:
        return False
    return (
        origin == "https://tool-vision.pages.dev"
        or origin.endswith(".tool-vision.pages.dev")
        or origin.startswith("http://localhost:")
        or origin.startswith("http://127.0.0.1:")
    )

def _font(sz):
    for p in ["/System/Library/Fonts/Helvetica.ttc", "/Library/Fonts/Arial.ttf"]:
        try: return ImageFont.truetype(p, sz)
        except: pass
    return ImageFont.load_default()

def _to_raster(img):
    if img.mode != "RGB":
        bg = _I.new("RGB", img.size, "white")
        bg.paste(img, mask=img.split()[-1] if img.mode in ("RGBA", "LA") else None)
        img = bg
    # Scale to the 696px (62mm) print width, preserving aspect.
    if img.width != 696:
        img = img.resize((696, max(1, round(img.height * 696 / img.width))), _I.ANTIALIAS)
    qlr = BrotherQLRaster("QL-800"); qlr.exception_on_warning = False
    return convert(qlr=qlr, images=[img], label="62", rotate="auto", threshold=70,
                   dither=False, compress=False, red=False, hq=True, cut=True)

def render_image(data_url):
    """Raster an already-rendered label PNG (data: URL or bare base64) from the app — keeps its QR."""
    b64 = data_url.split(",", 1)[1] if "," in data_url else data_url
    return _to_raster(_I.open(io.BytesIO(base64.b64decode(b64))))

def render(spec):
    """Fallback text renderer: {badge?, title, lines[]} -> 62mm raster bytes (no QR)."""
    badge = (spec.get("badge") or "").strip()
    title = (spec.get("title") or "Label").strip()
    lines = [str(l).strip() for l in (spec.get("lines") or []) if str(l).strip()]
    rows = ([("badge", badge)] if badge else []) + [("title", title)] + [("line", l) for l in lines]
    W = 696
    H = 60 + sum(90 if k == "badge" else 72 if k == "title" else 54 for k, _ in rows)
    img = _I.new("RGB", (W, H), "white"); d = ImageDraw.Draw(img); y = 26
    for kind, text in rows:
        sz = 84 if kind == "badge" else 60 if kind == "title" else 36
        d.text((30, y), text, fill="black", font=_font(sz))
        y += (90 if kind == "badge" else 72 if kind == "title" else 54)
    d.rectangle([6, 6, W - 7, H - 7], outline="black", width=3)
    return _to_raster(img)

def printer_status():
    try:
        out = subprocess.run(["lpstat", "-p", QUEUE], capture_output=True, text=True, timeout=5).stdout
        return out.strip().splitlines()[0] if out.strip() else "unknown"
    except Exception as e:
        return f"error: {e}"

class H(BaseHTTPRequestHandler):
    def _cors(self):
        origin = self.headers.get("Origin", "")
        if _origin_ok(origin):
            self.send_header("Access-Control-Allow-Origin", origin)  # reflect only trusted origins
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")
    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code); self._cors()
        self.send_header("Content-Type", "application/json"); self.end_headers()
        self.wfile.write(body)
    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.end_headers()
    def do_GET(self):
        if self.path.startswith("/health"):
            self._json(200, {"ok": True, "connector": "tool-vision", "queue": QUEUE, "status": printer_status()})
        else:
            self._json(404, {"error": "not found"})
    def do_POST(self):
        if not self.path.startswith("/print"):
            return self._json(404, {"error": "not found"})
        # Only the Tool Vision app may trigger a print (defends against any other local page).
        if not _origin_ok(self.headers.get("Origin", "")):
            return self._json(403, {"success": False, "message": "origin not allowed"})
        try:
            n = int(self.headers.get("Content-Length", 0))
            if n <= 0 or n > MAX_BODY:
                return self._json(413, {"success": False, "message": "request too large"})
            spec = json.loads(self.rfile.read(n) or b"{}")
            # Prefer the app's already-rendered label image (keeps its QR/layout); else text fallback.
            raster = render_image(spec["imageDataUrl"]) if spec.get("imageDataUrl") else render(spec)
            with tempfile.NamedTemporaryFile(suffix=".prn", delete=False) as f:
                f.write(raster); path = f.name
            r = subprocess.run(["lp", "-d", QUEUE, "-o", "raw", path], capture_output=True, text=True, timeout=20)
            os.unlink(path)
            if r.returncode == 0:
                self._json(200, {"success": True, "message": "Sent to QL-800", "job": r.stdout.strip()})
            else:
                self._json(500, {"success": False, "message": r.stderr.strip() or "lp failed"})
        except Exception as e:
            self._json(500, {"success": False, "message": str(e)})
    def log_message(self, *a): pass

if __name__ == "__main__":
    print(f"Tool Vision print connector on http://127.0.0.1:{PORT}  → {QUEUE}")
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
