#!/usr/bin/env python3
"""
Tool Vision — robotic socket-sorting host relay.

Runs on a small host (Raspberry Pi, Mac, or laptop) physically connected to a uArm Swift Pro
(USB). The phone/desktop app is the *vision brain*: it detects sockets + target tray slots,
maps them to arm coordinates, and POSTs a list of pick-and-place jobs here. This process drives
the arm over the official uArm-Python-SDK and toggles a magnetic end-effector to lift each
(ferromagnetic) socket and drop it into its tray slot.

Why a magnet: chrome sockets are steel; a magnet is far more reliable than a jaw gripper for
picking from a jumbled bucket, and the magnetic tray self-centers a socket dropped within a few mm.

Setup (see robot/README.md for the full parts list + wiring):
    pip install uarm-python-sdk flask
    python3 robot/arm_host.py --port 842
Then in the app, pair to this host's LAN address (http://<host-ip>:842).

SAFETY: this moves a physical arm. Keep the workspace clear, start with slow speed, and keep the
e-stop (unplug) within reach. Coordinates are in the uArm base frame (mm); calibrate first.
"""

import argparse
import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# The uArm SDK import is deferred so --dry-run works on a machine without the arm/SDK installed.
try:
    from uarm.wrapper import SwiftAPI  # type: ignore
except Exception:  # pragma: no cover - only present on the host with the arm
    SwiftAPI = None


class Arm:
    """Thin wrapper over the uArm SDK with a magnetic end-effector on a GPIO/PWM pin.

    The uArm exposes an Arduino-style digital pin; wire a logic-level MOSFET / relay to switch a
    12V electromagnet from that pin. set_magnet(True/False) toggles it.
    """

    def __init__(self, magnet_pin: int = 32, speed: int = 3000, dry_run: bool = False):
        self.magnet_pin = magnet_pin
        self.speed = speed
        self.dry_run = dry_run or SwiftAPI is None
        self.swift = None
        if not self.dry_run:
            self.swift = SwiftAPI(filters={"hwid": "USB VID:PID=2341:0042"})
            self.swift.waiting_ready(timeout=10)
            self.swift.set_mode(0)  # normal / suction-cup mode; we drive the pin ourselves
            self.home()

    def home(self):
        self._log("home")
        if self.swift:
            self.swift.reset(speed=self.speed, wait=True)

    def set_magnet(self, on: bool):
        self._log(f"magnet {'ON' if on else 'OFF'}")
        if self.swift:
            self.swift.set_digital_output(pin=self.magnet_pin, value=1 if on else 0)

    def move(self, x: float, y: float, z: float, wait: bool = True):
        self._log(f"move -> ({x:.1f}, {y:.1f}, {z:.1f})")
        if self.swift:
            self.swift.set_position(x=x, y=y, z=z, speed=self.speed, wait=wait)

    def pick_and_place(self, pick: dict, place: dict, hover: float = 40.0, settle: float = 0.25):
        """Lift a socket from `pick` and drop it at `place`. Coords are mm in the arm base frame."""
        # approach above the pick point, drop, magnetize, lift
        self.move(pick["x"], pick["y"], pick["z"] + hover)
        self.move(pick["x"], pick["y"], pick["z"])
        self.set_magnet(True)
        time.sleep(settle)
        self.move(pick["x"], pick["y"], pick["z"] + hover)
        # travel to the slot, lower, release, lift
        self.move(place["x"], place["y"], place["z"] + hover)
        self.move(place["x"], place["y"], place["z"])
        self.set_magnet(False)
        time.sleep(settle)
        self.move(place["x"], place["y"], place["z"] + hover)

    def _log(self, msg: str):
        print(f"[arm]{' (dry-run)' if self.dry_run else ''} {msg}", flush=True)


def make_handler(arm: Arm, allowed_origin: str):
    class Handler(BaseHTTPRequestHandler):
        def _send(self, code, obj):
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", allowed_origin)
            self.send_header("Access-Control-Allow-Headers", "content-type")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self):
            self._send(204, {})

        def do_GET(self):
            if self.path == "/health":
                self._send(200, {"ok": True, "dryRun": arm.dry_run, "magnetPin": arm.magnet_pin})
            else:
                self._send(404, {"error": "not found"})

        def do_POST(self):
            length = int(self.headers.get("content-length", 0))
            try:
                payload = json.loads(self.rfile.read(length) or b"{}")
            except json.JSONDecodeError:
                return self._send(400, {"error": "bad json"})

            if self.path == "/home":
                arm.home()
                return self._send(200, {"ok": True})

            if self.path == "/sort":
                # payload: { jobs: [{ label, pick:{x,y,z}, place:{x,y,z} }, ...] }
                jobs = payload.get("jobs") or []
                if not isinstance(jobs, list) or not jobs:
                    return self._send(400, {"error": "no jobs"})
                done = []
                for i, job in enumerate(jobs):
                    pick, place = job.get("pick"), job.get("place")
                    if not (pick and place):
                        continue
                    arm.pick_and_place(pick, place)
                    done.append(job.get("label", f"job {i}"))
                arm.home()
                return self._send(200, {"ok": True, "placed": done, "count": len(done)})

            self._send(404, {"error": "not found"})

        def log_message(self, *args):  # quiet default access logging
            pass

    return Handler


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=842)
    ap.add_argument("--magnet-pin", type=int, default=32)
    ap.add_argument("--speed", type=int, default=3000)
    ap.add_argument("--origin", default="*", help="CORS origin to allow (set to the app URL in prod)")
    ap.add_argument("--dry-run", action="store_true", help="run without the arm/SDK (logs moves)")
    args = ap.parse_args()

    arm = Arm(magnet_pin=args.magnet_pin, speed=args.speed, dry_run=args.dry_run)
    httpd = ThreadingHTTPServer(("0.0.0.0", args.port), make_handler(arm, args.origin))
    print(f"[host] listening on :{args.port}  (dry-run={arm.dry_run})", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        arm.set_magnet(False)
        print("\n[host] stopped", flush=True)


if __name__ == "__main__":
    main()
