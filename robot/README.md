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

## Reach vs. the 18" trays — read this first

The magnetic socket trays are **18" (~457 mm) long**. A hobby arm's reach is a *radius* from its base
(uArm Swift Pro ≈ 320 mm), so an 18" tray laid **straight** in front of the arm puts its end slots
**out of reach**. Two ways to solve it, pick one:

1. **Arc the trays around the arm (recommended, $0):** place each 18" tray on a shallow curve so every
   slot sits within ~150–300 mm of the base. The 6-tray SWANLAKE set fans out as an arc; the app's
   calibration captures each slot's real (x,y). This keeps the cheap arm viable.
2. **Add a small turntable/lazy-susan (~$15):** mount the tray(s) on it; the app rotates the needed
   section into reach between picks. Simplest if you want the trays laid straight.
3. **Bigger-reach arm (only if you want zero workarounds):** an arm with ~450 mm+ reach (e.g. Annin
   **AR4**, ~$2k kit, 600 mm) covers a straight 18" tray outright — overkill for most.

The bucket of loose sockets sits within reach on the opposite side of the base from the trays.

## Amazon shopping list

### Core (recommended build, ≈ $800)
1. **uArm Swift Pro** robotic arm — ~$749. Real Python SDK (`uArm-Python-SDK`), 500 g payload
   (margin for 1/2" sockets), 0.2 mm repeatability. Use the arc/turntable layout above for 18" trays.
   https://www.amazon.com/Swift-Open-Source-Robotic-STEAM-Makers/dp/B07MQ4S1LJ
2. **12 V electromagnet, ~25–50 N holding** (the end-effector — sockets are steel) — ~$8–12.
   Search: "12V 25N solenoid electromagnet".
3. **1-channel 5 V relay module** (or an IRLB8721 logic-level MOSFET) to switch the magnet from the
   arm's digital pin — ~$7.
4. **12 V / 2 A power supply** for the electromagnet — ~$9.
5. **DuPont jumper wires** (M-F + M-M assortment) to wire pin → relay → magnet — ~$7.

### Workspace / vision (you said you'll use your phone as the camera)
6. **Phone overhead mount / gooseneck tripod** — stable top-down shots for detection — ~$15–20.
7. **LED light panel or ring light** — consistent lighting = reliable socket detection — ~$20.
8. **Turntable / lazy-susan bearing** (~$15) — *only if* you choose layout option 2 above.
9. **Shallow tray / baking sheet** to spread (singulate) the loose sockets before picking — ~$10
   (or reuse one you own). Makes single-socket picks far more reliable.

### Host (skip if you'll use your existing Mac/laptop)
10. **Raspberry Pi 4 (4 GB) kit** (with PSU + microSD) — dedicated arm controller — ~$70–90.

You already have the **18" magnetic socket trays** (SWANLAKE) — those are the drop targets; their
magnets self-center a socket dropped within a few mm, so placement only needs ~1–2 mm accuracy.

### Budget / prototype path (≈ $300, prove the loop first)
- **Yahboom DOFBOT** — ~$289, ships with a camera + ROS2/Python/OpenCV sorting demos. Cheapest way to
  prove detect→pick→place before committing. (Reach ~270 mm — same 18"-tray arc caveat applies.)
  https://www.amazon.com/Yahboom-Jetson-Nano-Identity-Programming%EF%BC%88DOFBOT/dp/B08T6N36YR

> Verify current price/stock on each Amazon page before buying; prices fluctuate.

## Wiring (uArm + electromagnet)
- uArm exposes Arduino-style digital pins. Wire the chosen pin (default **32**, change with
  `--magnet-pin`) → MOSFET/relay gate → switches the 12 V electromagnet. Common ground.
- `set_magnet(True)` drives the pin high (magnet on); `False` releases.

## Run the host
```bash
pip install uarm-python-sdk             # the script otherwise uses only the Python stdlib
python3 arm_host.py --port 842          # add --dry-run to test with no arm (logs every move)
```
On start it prints a **PAIR TOKEN** and the LAN URL. In the app, enter that URL + token to pair.

**Security (this endpoint actuates a physical arm, so it is locked down):**
- Every command requires the `x-arm-token` header = the printed token (401 otherwise).
- Host-header allowlist (localhost / this machine's LAN IP) blocks DNS-rebinding attacks.
- CORS is a single exact origin (`--origin`, default the app URL) — never `*`.
- Keep the host on a trusted LAN; the token is your pairing secret.

## HTTP protocol
All POSTs require header `x-arm-token: <printed token>`.
- `GET /health` → `{ ok, dryRun, magnetPin, needsToken }` (no token needed — reachability probe)
- `POST /home` → re-home the arm
- `POST /sort` with:
  ```json
  { "jobs": [ { "label": "10mm", "pick": {"x":200,"y":-50,"z":10}, "place": {"x":250,"y":80,"z":15} } ] }
  ```
  Executes each job (approach → magnet ON → lift → travel → lower → magnet OFF → lift), then homes.
  Returns `{ ok, placed:[labels], count }`.

## End-to-end pipeline
1. **Singulate** — dump the bucket onto the shallow tray so sockets are mostly separated (raises
   single-pick reliability).
2. **Capture** — phone takes a top-down photo of the spread sockets + the tray arc.
3. **Detect + classify** — the app's Qwen3-VL vision (reuses `/detect-spots`) boxes each socket and
   reads/estimates its size (10 mm, 1/2", …).
4. **Map to slots** — each detected size → its labeled slot on the tray; slot (x,y) comes from the
   known 18" tray geometry + the arc origin set during calibration.
5. **Plan** — the app builds the ordered pick-and-place job list (nearest-first to reduce travel).
6. **Execute** — POST the jobs to this host; the arm does approach → magnet ON → lift → move to slot
   → magnet OFF for each, then homes.
7. **Verify (optional)** — re-photo the tray; flag any empty target slots for a retry pass.

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
