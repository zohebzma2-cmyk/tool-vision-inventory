# Tool Vision — Robotic Socket Sorter

Sort a bucket of loose sockets into a magnetic socket tray, driven by the app's AI vision.

**Architecture:** the phone/desktop app is the *vision brain* — it detects each socket and its
target tray slot and computes pick-and-place coordinates. A small **host** (Raspberry Pi, Mac, or
laptop) plugged into the arm over USB runs `arm_host.py`, which drives the arm and toggles a magnet.
The app POSTs jobs to the host over the LAN.

```
[app: detect sockets + slots, compute coords]
      │  POST /sort { jobs:[{label, pick:{x,y,z}, place:{x,y,z}}] }
      ▼
[host: arm_host.py + uArm-Python-SDK]
      ▼
[uArm Swift Pro + electromagnet]  pick (magnet ON) → place (magnet OFF)
```

## What to buy on Amazon

**Recommended build (~$800–850):**
1. **uArm Swift Pro** robotic arm — ~$749. Best value with a *real* Python SDK (`uArm-Python-SDK`),
   500 g payload (margin for big 1/2" sockets), 0.2 mm repeatability.
   https://www.amazon.com/Swift-Open-Source-Robotic-STEAM-Makers/dp/B07MQ4S1LJ
2. **Electromagnet end-effector** — a small **12 V holding electromagnet (~25–50 N / 5–10 lb)** plus a
   **logic-level MOSFET or 1-channel relay module** and a 12 V supply. ~$15–25 total. This is the key
   trick: sockets are chrome-plated *steel*, so a magnet lifts them far more reliably than a jaw
   gripper picking from a pile. (Search: "12V 25N electromagnet" + "5V relay module".)
3. **Host:** use a Mac/laptop you already own, or a **Raspberry Pi 4/5** (~$60–80) as a dedicated host.

**Budget / prototype path (~$300):**
- **Yahboom DOFBOT** — ~$289, **ships with a camera + ROS2/Python/OpenCV vision-sorting demos**.
  Cheapest way to prove the full detect→pick→place loop before committing to the uArm.
  https://www.amazon.com/Yahboom-Jetson-Nano-Identity-Programming%EF%BC%88DOFBOT/dp/B08T6N36YR

**Also useful:** the magnetic socket trays you already have (e.g. SWANLAKE 6-pc) are the drop targets —
their magnets self-center a socket dropped within a few mm, so placement only needs ~1–2 mm accuracy.

> Verify current price/stock on each Amazon page before buying; prices fluctuate.

## Wiring (uArm + electromagnet)
- uArm exposes Arduino-style digital pins. Wire the chosen pin (default **32**, change with
  `--magnet-pin`) → MOSFET/relay gate → switches the 12 V electromagnet. Common ground.
- `set_magnet(True)` drives the pin high (magnet on); `False` releases.

## Run the host
```bash
pip install uarm-python-sdk flask        # flask optional; the script uses stdlib http.server
python3 arm_host.py --port 842           # add --dry-run to test with no arm (logs every move)
```
Then in the app, pair to `http://<host-ip>:842`.

## HTTP protocol
- `GET /health` → `{ ok, dryRun, magnetPin }`
- `POST /home` → re-home the arm
- `POST /sort` with:
  ```json
  { "jobs": [ { "label": "10mm", "pick": {"x":200,"y":-50,"z":10}, "place": {"x":250,"y":80,"z":15} } ] }
  ```
  Executes each job (approach → magnet ON → lift → travel → lower → magnet OFF → lift), then homes.
  Returns `{ ok, placed:[labels], count }`.

## Calibration (one-time, the real work)
Coordinates are in the **arm base frame (mm)**. To turn camera pixels into arm coordinates:
1. Place 3–4 reference dots at known arm coordinates in the workspace; click them in the app's
   camera view to solve a pixel→arm homography (hand-eye calibration).
2. The magnetic tray's slot geometry is fixed/known per tray model, so slot (place) coordinates come
   from the tray layout + its origin, not per-slot vision.
3. Pick Z ≈ bucket floor; place Z ≈ just above the slot (let the tray magnet capture the drop).

## Status
`arm_host.py` is verified in `--dry-run` (full pick-and-place sequence + HTTP API). The live arm path
is untested pending hardware. App-side pairing + coordinate export is the next build once an arm is on
hand (see `docs/superpowers/specs/2026-07-13-bin-sorting-and-robotic-arm-design.md`).
