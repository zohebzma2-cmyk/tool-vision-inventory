#!/usr/bin/env python3
"""Tool Vision local print connector — bridges the web app (HTTP) to the QL-800 (CUPS).
Both the browser app and the terminal print through the same CUPS queue, so they never fight
over the USB device (no WebUSB needed). Listens on 127.0.0.1:17777."""
import json, subprocess, tempfile, os, datetime, base64, io, time, socket, threading, re

# Serialize prints: the server is threaded, and the QL-800 prints one job at a time. Without this,
# concurrent /print calls (e.g. "print all labels") race for the printer and some time out.
_print_lock = threading.Lock()
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
# Serve the built app so the whole thing is same-origin localhost (no HTTPS→localhost PNA block).
DIST = os.path.expanduser("~/tool-vision-inventory/dist")
import mimetypes, posixpath, ipaddress
from urllib.parse import urlparse

# --- Phone capture station: the phone opens /capture, the NATIVE camera opens (a file-capture input,
# so it works over the LAN with no HTTPS), and photos upload here for Claude to read. A request queue
# lets Claude ask for a specific shot ("photo of the bin wall") and the phone shows that prompt. ---
CAPTURES_DIR = os.path.expanduser("~/.tool-vision-connector/captures")
os.makedirs(CAPTURES_DIR, exist_ok=True)
_capture_req = {"id": 0, "prompt": "", "ts": 0}  # set by Claude (loopback), polled by the phone

CAPTURE_HTML = """<!doctype html><html><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Tool Vision — Capture</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;font:16px/1.4 -apple-system,system-ui,sans-serif;background:#12151b;color:#eef1f5;
 padding:20px;display:flex;flex-direction:column;gap:18px;min-height:100vh}
h1{font-size:20px;margin:0}.sub{color:#9aa4b2;font-size:14px;margin-top:-10px}
.req{background:#1b2430;border:1px solid #2b3a4d;border-radius:14px;padding:14px 16px}
.req b{color:#ffb020}
label.shoot{display:flex;align-items:center;justify-content:center;gap:10px;background:#E35F22;color:#fff;
 font-weight:700;font-size:18px;padding:20px;border-radius:16px;cursor:pointer;box-shadow:0 6px 20px #0006}
label.shoot input{display:none}
img#pv{width:100%;border-radius:14px;display:none;margin-top:6px}
.status{font-size:14px;color:#9aa4b2;min-height:20px}
.ok{color:#37d67a}.err{color:#ff5a5f}
</style></head><body>
<h1>Tool Vision · Capture</h1>
<div class=sub>Snap a photo — it goes straight to Claude.</div>
<div class=req id=req style=display:none></div>
<label class=shoot>📷 Take photo
 <input type=file accept="image/*" capture="environment" id=f></label>
<img id=pv>
<div class=status id=st></div>
<script>
const st=document.getElementById('st'),pv=document.getElementById('pv'),req=document.getElementById('req');
let curPrompt='';
async function poll(){try{const r=await fetch('/capture-request',{cache:'no-store'});const j=await r.json();
 if(j.prompt){curPrompt=j.prompt;req.style.display='block';
  req.textContent='Claude asked for: ';const b=document.createElement('b');b.textContent=j.prompt;req.append(b);}
 else{curPrompt='';req.style.display='none';}}catch(e){}}
poll();setInterval(poll,2500);
document.getElementById('f').onchange=async e=>{
 const file=e.target.files[0];if(!file)return;
 st.textContent='Processing…';st.className='status';
 const img=new Image();img.src=URL.createObjectURL(file);await img.decode();
 const max=1600,sc=Math.min(1,max/Math.max(img.width,img.height));
 const c=document.createElement('canvas');c.width=Math.round(img.width*sc);c.height=Math.round(img.height*sc);
 c.getContext('2d').drawImage(img,0,0,c.width,c.height);
 const data=c.toDataURL('image/jpeg',0.85);pv.src=data;pv.style.display='block';
 st.textContent='Sending to Claude…';
 try{const r=await fetch('/upload',{method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({image:data,label:curPrompt})});const j=await r.json();
  if(r.ok&&j.ok){st.textContent='✓ Sent to Claude'+(curPrompt?' — '+curPrompt:'');st.className='status ok';}
  else{st.textContent='Upload failed: '+(j.message||r.status);st.className='status err';}}
 catch(err){st.textContent='Upload error — same Wi-Fi as the computer?';st.className='status err';}
 e.target.value='';};
</script></body></html>"""

def _origin_ok(origin: str) -> bool:
    """Only the Tool Vision app may drive the printer. Every allowed origin is matched by EXACT host
    (or a bounded set: private-LAN IPs, this Mac's own mDNS name, the fixed app scheme) — no substring
    or suffix matching. The public https://tool-vision.pages.dev site is deliberately NOT allowed: it
    physically can't reach this connector anyway (Chrome Private Network Access blocks a public HTTPS
    origin from calling localhost/LAN — which is exactly why the app is served from localhost:17777),
    so listing it would be dead code + needless attack surface. NOTE: Origin is browser-set and thus
    spoofable by a non-browser LAN client — this stops malicious *websites*, not a hostile process
    already on your network (see /notify-text, additionally locked to this computer)."""
    if not origin:
        return False
    try:
        u = urlparse(origin)
        host, scheme, port = u.hostname, u.scheme, u.port
    except (ValueError, TypeError):
        return False
    if not host:
        return False
    if scheme == "http":
        if host in ("localhost", "127.0.0.1"):
            return True  # local dev server (any port) or the connector itself
        # Phone-relay: the app served by THIS connector at the laptop's private-LAN address OR its
        # OWN stable mDNS .local name (survives DHCP changes) — on our port. Exact-match the mDNS name;
        # never a blanket ".local" suffix (which any host could satisfy).
        if port == PORT:
            try:
                return ipaddress.ip_address(host).is_private
            except ValueError:
                return bool(_MDNS_HOST) and host.rstrip(".").lower() == _MDNS_HOST
    # The Capacitor iOS/Android app runs at capacitor://localhost (native shell, not a website) and
    # reaches this connector over the LAN to print — allow that fixed app origin.
    if scheme in ("capacitor", "ionic") and host == "localhost":
        return True
    return False

def _font(sz):
    for p in ["/System/Library/Fonts/Helvetica.ttc", "/Library/Fonts/Arial.ttf"]:
        try: return ImageFont.truetype(p, sz)
        except: pass
    return ImageFont.load_default()

# Printable width (dots @ 300dpi) for each DK tape id. The label is always as wide as the tape, so
# this is what sets the physical label width. Continuous tapes (62/29/12) cut to any length; die-cut
# (…x…) are a fixed size. `media` on /print picks the tape — it MUST match the tape actually loaded.
_MEDIA_WIDTH = {"62": 696, "29": 306, "12": 106, "50": 554, "54": 590, "38": 413,
                "17x54": 165, "23x23": 202, "29x90": 306, "62x100": 696, "52x29": 578}

def _to_raster(img, media="62"):
    if img.mode != "RGB":
        bg = _I.new("RGB", img.size, "white")
        bg.paste(img, mask=img.split()[-1] if img.mode in ("RGBA", "LA") else None)
        img = bg
    w = _MEDIA_WIDTH.get(media, 696)
    if img.width != w:  # scale to the loaded tape's print width, preserving aspect
        img = img.resize((w, max(1, round(img.height * w / img.width))), _I.ANTIALIAS)
    qlr = BrotherQLRaster("QL-800"); qlr.exception_on_warning = False
    return convert(qlr=qlr, images=[img], label=media, rotate="auto", threshold=70,
                   dither=False, compress=False, red=False, hq=True, cut=True)

def render_image(data_url, media="62"):
    """Raster an already-rendered label PNG (data: URL or bare base64) from the app — keeps its QR."""
    b64 = data_url.split(",", 1)[1] if "," in data_url else data_url
    return _to_raster(_I.open(io.BytesIO(base64.b64decode(b64))), media)

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

# The owner's phone for weekly organization nudges. Only THIS Mac runs the connector and it only ever
# texts this one fixed number, so the /notify-text route can't be abused to message anyone else.
OWNER_PHONE = os.environ.get("TOOLVISION_OWNER_PHONE", "+16035051091")

def send_imessage(text):
    """Send an iMessage to the owner via Messages.app. The body is passed as an argv arg (not string-
    interpolated into the AppleScript) so no quoting/escaping can break or inject."""
    script = (
        "on run argv\n"
        "  set msg to item 1 of argv\n"
        "  tell application \"Messages\"\n"
        "    set svc to 1st service whose service type = iMessage\n"
        f"    send msg to buddy \"{OWNER_PHONE}\" of svc\n"
        "  end tell\n"
        "end run\n"
    )
    r = subprocess.run(["osascript", "-", text], input=script, capture_output=True, text=True, timeout=20)
    return (r.returncode == 0), (r.stderr.strip() or "sent")

def printer_status():
    try:
        out = subprocess.run(["lpstat", "-p", QUEUE], capture_output=True, text=True, timeout=5).stdout
        return out.strip().splitlines()[0] if out.strip() else "unknown"
    except Exception as e:
        return f"error: {e}"

def _lan_ip():
    """This machine's LAN IP (so the app can tell the user what address to point the iOS app at)."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))  # no packets sent; just picks the outbound interface
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return ""

def _mdns_host():
    """This Mac's Bonjour/mDNS name (e.g. zohebs-MacBook-Pro.local). Preferred over the LAN IP for the
    iOS/phone app because it stays valid even when DHCP reassigns the IP."""
    try:
        n = subprocess.run(["scutil", "--get", "LocalHostName"], capture_output=True, text=True, timeout=3).stdout.strip()
        return f"{n}.local" if n else ""
    except Exception:
        return ""

# THIS machine's mDNS name, resolved once at startup and normalized. The origin allowlist compares
# against this EXACT string — never a blanket ".local" suffix, so a hostile page at some-other.local
# can't slip past by ending in ".local".
_MDNS_HOST = _mdns_host().rstrip(".").lower()

def _queue_has_jobs():
    try:
        out = subprocess.run(["lpstat", "-o", QUEUE], capture_output=True, text=True, timeout=5).stdout
        return bool(out.strip())
    except Exception:
        return False

def _submit(path):
    return subprocess.run(["lp", "-d", QUEUE, "-o", "raw", path], capture_output=True, text=True, timeout=20)

def _job_id(submit_stdout):
    # lp prints e.g. "request id is ToolVision_QL800-205 (1 file(s))".
    m = re.search(r"([A-Za-z0-9_\-]+-\d+)", submit_stdout or "")
    return m.group(1) if m else None

def _job_in_queue(job_id):
    """Is THIS job still pending/printing? (Falls back to any-job if we couldn't parse the id.)"""
    try:
        out = subprocess.run(["lpstat", "-o", QUEUE], capture_output=True, text=True, timeout=5).stdout
        if not job_id:
            return bool(out.strip())
        return any(line.split()[0] == job_id for line in out.splitlines() if line.strip())
    except Exception:
        return False

def _printer_wedged():
    """The printer can't reach the device (backend stuck), is marked offline, or the queue is disabled
    — the states that actually need recovery, as opposed to a job that's simply slow to print."""
    try:
        out = subprocess.run(["lpstat", "-p", QUEUE], capture_output=True, text=True, timeout=5).stdout.lower()
        return any(s in out for s in ("waiting for printer to become available", "offline", "disabled"))
    except Exception:
        return False

def _cancel(job):
    """Cancel just OUR job (never `cancel -a`, which would nuke a concurrent terminal print)."""
    if job:
        subprocess.run(["cancel", job], capture_output=True, text=True, timeout=5)

def print_raw(path):
    """Submit a raw raster job AND confirm OUR job actually printed. `lp` returns as soon as CUPS
    accepts the job, so we track our job id and wait for it to leave the queue. A slow-but-printing
    job is left alone — we only auto-recover on a SUSTAINED wedge (printer can't reach the device),
    and then cancel only OUR job (never `cancel -a`, which would kill a concurrent terminal print).
    Returns (ok, message)."""
    def wait_outcome(job, timeout):
        # "done" = left the queue (printed); "wedged" = sustained can't-reach-device; "timeout" = neither.
        deadline = time.time() + timeout
        wedged_since = None
        while time.time() < deadline:
            if not _job_in_queue(job):
                return "done"
            if _printer_wedged():
                wedged_since = wedged_since or time.time()
                if time.time() - wedged_since > 3:   # sustained, not a momentary blip
                    return "wedged"
            else:
                wedged_since = None
            time.sleep(0.5)
        return "timeout"

    r = _submit(path)
    if r.returncode != 0:
        return False, (r.stderr.strip() or "lp failed")
    job = _job_id(r.stdout)
    outcome = wait_outcome(job, 11)
    if outcome == "done":
        return True, "Printed on the QL-800."
    if outcome == "timeout":
        # Never confirmed it printed, but not clearly wedged either — do NOT resubmit (that's how a
        # slow-but-healthy job turns into a double print). Cancel it so it can't print later, report honestly.
        _cancel(job)
        return False, "Printer didn't finish in time — check it's on with a label roll loaded."
    # Genuinely wedged/offline → cancel only OUR job, re-enable the queue (no sudo), resubmit once.
    _cancel(job)
    subprocess.run(["cupsenable", QUEUE], capture_output=True, text=True, timeout=5)
    time.sleep(1.0)
    r2 = _submit(path)
    if r2.returncode != 0:
        return False, (r2.stderr.strip() or "lp failed after recovery")
    job2 = _job_id(r2.stdout)
    if wait_outcome(job2, 11) == "done":
        return True, "Printed on the QL-800 (auto-recovered)."
    _cancel(job2)  # don't leave the retry stuck to print when the printer returns
    return False, "Printer didn't respond — check it's powered on with a label roll loaded."

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
            return self._json(200, {"ok": True, "connector": "tool-vision", "queue": QUEUE,
                                    "status": printer_status(), "lan": _lan_ip(),
                                    "host": _mdns_host(), "port": PORT})
        if self.path.startswith("/capture-request"):
            # The phone polls this to see if Claude has asked for a specific shot.
            return self._json(200, {"id": _capture_req["id"], "prompt": _capture_req["prompt"]})
        if self.path.startswith("/capture"):
            # The mobile capture page (native camera → upload).
            body = CAPTURE_HTML.encode()
            self.send_response(200); self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
            return
        # Otherwise serve the built app (same-origin localhost — printing works with no PNA/CORS).
        self._serve_static(self.path.split("?", 1)[0])

    def _serve_static(self, path):
        rel = posixpath.normpath(path.lstrip("/"))
        if rel.startswith("..") or os.path.isabs(rel):
            return self._json(403, {"error": "bad path"})
        full = os.path.join(DIST, rel)
        if not os.path.isfile(full):
            full = os.path.join(DIST, "index.html")  # SPA fallback
        if not os.path.isfile(full):
            return self._json(503, {"error": "app build not found — run `npm run build` in tool-vision-inventory"})
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        try:
            with open(full, "rb") as f:
                body = f.read()
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            self._json(500, {"error": str(e)})
    def do_POST(self):
        if not any(self.path.startswith(p) for p in ("/print", "/notify-text", "/upload", "/capture-request")):
            return self._json(404, {"error": "not found"})
        # Only the Tool Vision app / capture page may POST (defends against any other local page).
        if not _origin_ok(self.headers.get("Origin", "")):
            return self._json(403, {"success": False, "message": "origin not allowed"})
        try:
            n = int(self.headers.get("Content-Length", 0))
            if n <= 0 or n > MAX_BODY:
                return self._json(413, {"success": False, "message": "request too large"})
            body = json.loads(self.rfile.read(n) or b"{}")

            client_ip = self.client_address[0] if self.client_address else ""
            is_loopback = client_ip == "::1" or client_ip.startswith("127.")

            if self.path.startswith("/capture-request"):
                # Claude (loopback) queues a photo request the phone will display.
                if not is_loopback:
                    return self._json(403, {"ok": False, "message": "requests only from this computer"})
                _capture_req["id"] += 1
                _capture_req["prompt"] = str(body.get("prompt") or "").strip()[:200]
                _capture_req["ts"] = int(time.time())
                return self._json(200, {"ok": True, "id": _capture_req["id"]})

            if self.path.startswith("/upload"):
                # The phone uploads a captured photo (data URL). Saved for Claude to read.
                data_url = body.get("image") or ""
                if "," not in data_url:
                    return self._json(400, {"ok": False, "message": "no image"})
                raw = base64.b64decode(data_url.split(",", 1)[1])
                label = "".join(c if c.isalnum() or c in "-_" else "-" for c in (body.get("label") or "photo"))[:40]
                fname = f"{int(time.time())}-{label or 'photo'}.jpg"
                with open(os.path.join(CAPTURES_DIR, fname), "wb") as f:
                    f.write(raw)
                # A capture fulfills the outstanding request.
                _capture_req["prompt"] = ""
                return self._json(200, {"ok": True, "file": fname})

            if self.path.startswith("/notify-text"):
                # Texting the owner is the sensitive action — restrict it to requests from THIS
                # computer (loopback). LAN devices can print labels but can't trigger texts, so
                # opening the printer to the phone doesn't also open an iMessage-spam vector.
                client_ip = self.client_address[0] if self.client_address else ""
                if not (client_ip == "::1" or client_ip.startswith("127.")):
                    return self._json(403, {"success": False, "message": "texts only from this computer"})
                msg = str(body.get("message") or "").strip()[:1000]
                if not msg:
                    return self._json(400, {"success": False, "message": "empty message"})
                ok, detail = send_imessage(msg)
                return self._json(200 if ok else 500, {"success": ok, "message": detail})

            spec = body
            media = str(spec.get("media") or "62")  # DK tape id — must match the loaded tape
            # Prefer the app's already-rendered label image (keeps its QR/layout); else text fallback.
            raster = render_image(spec["imageDataUrl"], media) if spec.get("imageDataUrl") else render(spec)
            with tempfile.NamedTemporaryFile(suffix=".prn", delete=False) as f:
                f.write(raster); path = f.name
            try:
                # Submit AND confirm it actually prints (self-heals a wedged queue, no power-cycle).
                # Serialized so overlapping prints queue cleanly instead of racing the one printer.
                with _print_lock:
                    ok, msg = print_raw(path)
            finally:
                try: os.unlink(path)
                except OSError: pass
            self._json(200 if ok else 500, {"success": ok, "message": msg})
        except Exception as e:
            self._json(500, {"success": False, "message": str(e)})
    def log_message(self, *a): pass

if __name__ == "__main__":
    # Bind all interfaces so a phone on the same Wi-Fi can print via the laptop (origin-gated to the
    # app served from a private-LAN address). Localhost still works exactly as before.
    print(f"Tool Vision print connector on http://0.0.0.0:{PORT}  → {QUEUE}")
    ThreadingHTTPServer(("0.0.0.0", PORT), H).serve_forever()
