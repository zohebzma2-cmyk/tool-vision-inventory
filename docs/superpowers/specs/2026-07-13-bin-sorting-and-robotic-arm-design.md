# Bin Sorting Mode + Robotic Socket-Sorting Arm — Design

Date: 2026-07-13
Status: Design (bin-sorting = build next; robotic arm = design + research, hardware-gated)

Two related capabilities the user requested:
1. **Bin Sorting Mode** — photograph the inside of a tote/bin → AI estimates the tote size →
   user confirms the size in gallons → AI processes and shows what's inside → store it and
   auto-generate a bin label with a general summary of the contents.
2. **Robotic socket-sorting arm** — a physical arm that sorts a bucket of loose sockets into a
   magnetic socket tray, driven by the app's vision. Research is done (below); build is gated on
   buying hardware.

---

## Part 1 — Bin Sorting Mode (BUILD)

### Goal & flow
A frictionless "dump bin → labeled, catalogued bin" loop for blue-collar users:
1. Tap **Sort a bin** (new entry, mobile bottom bar + Spaces).
2. **Snap the inside of the tote.**
3. **AI estimates the tote size** (small/medium/large → a gallon figure) from the photo.
4. **Confirm size** — a one-tap chooser prefilled with the AI's guess (e.g. "Looks like a ~12 gal
   tote — right?"), editable in gallons.
5. **Processing view** — the shared `VisionProgress` animation while the AI enumerates contents
   (reuses `/identify-bin`), captions tuned to sorting ("Emptying the bin", "Counting parts", …).
6. **Store** — items saved to the bin (reuses the BinFill insert path: items + item_locations),
   the bin location gets/keeps its `layout.gallons`.
7. **Auto bin label** — generate a label whose body is a **general summary** of what's inside
   ("Assorted plumbing fittings + PVC", not a 40-line list) plus the bin's QR + size, printable on
   the Brother printer (reuses `brotherPrint`/`LabelTemplateRenderer`).

### Why it's mostly reuse
The identify-bin AI, the item-insert path, VisionProgress, and label printing all exist. The genuinely
new pieces are: **tote-size estimation**, the **gallon confirm step**, and the **general-summary label**.

### Worker — extend `/identify-bin` (or add `/sort-bin`)
Add an optional richer response so one call returns both contents and metadata. Prefer extending
`/identify-bin` to also return:
```
{
  items: [...same as today...],
  tote: { sizeGuess: "small"|"medium"|"large", gallonsGuess: number },   // NEW
  summary: string   // NEW — one short human phrase describing the bin's overall contents
}
```
- `gallonsGuess`: clamp to a sane range (1–55 gal). The model estimates from visual cues
  (hand/tool scale, known tote proportions). Be honest it's a rough guess — that's why the user
  confirms.
- `summary`: ≤ 8 words, the "general say of what is there" for the label.
- Keep it strict-JSON + clamped like the other endpoints; fall back gracefully (missing tote/summary
  → derive summary client-side from the dominant category, default gallons unset so the user just picks).

### Client — `vision.ts`
Extend `identifyBinFromImage` return type (or add `sortBinFromImage`) to include `tote` + `summary`.

### Data
- Bin size: store on the bin location `layout.gallons` (number). No migration — `layout` is jsonb.
- Contents summary: store on `layout.summary` (string) so the label + list can show it without
  re-deriving.
- Items: unchanged (items + item_locations), reusing BinFill's insert (and the **identity-mapped
  quantity fix** from the bug pass, not index-mapped).

### UI — new `SortBinDialog.tsx` (adaptive-dialog, mobile-first)
Steps in one sheet with the pinned footer:
1. Snap photo (camera) → auto-runs estimate.
2. Size confirm: segmented chips (Small ~5 gal / Medium ~12 gal / Large ~27 gal) prefilled to the
   guess, plus a gallons number field. (Common Sterilite/HDX tote sizes as presets.)
3. VisionProgress while enumerating (only after size confirmed, so the summary can reference size).
4. Editable review rows (reuse BinFill's row UI + misfile flags) + an editable **summary** line.
5. Save → insert items, write `layout.gallons`/`layout.summary`, then offer **Print bin label**.

### Label
A "Bin label" template variant: bin name + size ("12 gal") + the general summary + QR. Reuse
`LabelTemplateRenderer`; the QR resolves to the bin in `QRScanner` (already supported).

### Testing / verification
- Live `/identify-bin` (extended) via curl with a real bin photo → returns items + tote + summary.
- In-browser (desktop + 390px): full flow snap→confirm→process→review→save→label renders and the
  sheet footer stays reachable.

### Risks
- Gallon estimate from a single photo is inherently rough → the **confirm step is the mitigation**;
  never present it as exact.
- Don't regress the existing BinFill flow — SortBin is additive; BinFill stays.

---

## Part 2 — Robotic Socket-Sorting Arm (DESIGN + RESEARCH; hardware-gated)

### The task
Sort a bucket of loose sockets into a magnetic socket tray (e.g. SWANLAKE 6-pc magnetic trays:
labeled slots by drive 1/4"/3/8"/1/2", SAE + metric). The app is the vision + UI brain; the arm
executes pick-and-place.

### Key insight from research
**Sockets are chrome-plated steel = ferromagnetic.** Picking smooth, overlapping chrome sockets
from a jumbled bucket with a parallel-jaw gripper is unreliable — the dominant failure mode. A
**magnetic (switchable/electro-) end-effector is dramatically more robust**: touch-and-lift, orientation-
tolerant. And magnetic-slot trays self-center a socket dropped within a few mm, so **placement only
needs ~1–2 mm accuracy** — which even hobby arms can hit. This reframes the whole project as feasible.

### Hardware options (Amazon US, verified listings — confirm price/stock on the ASIN page)
| Arm | ~Price | DOF | Reach | Payload | Repeat. | SDK | Notes |
|-----|--------|-----|-------|---------|---------|-----|-------|
| **uArm Swift Pro** ⭐ | ~$749 | 4 | 50–320mm | 500g | 0.2mm | **uArm-Python-SDK (mature)** | Best value w/ real SDK; payload margin for 1/2" sockets. Add magnetic effector. |
| Dobot Magician Lite | ~$995 | 4 | 340mm | 250g | 0.2mm | pydobot/Dobot API | Swappable factory tooling; less payload. |
| WLKATA Mirobot | ~$1–1.2k | 6 | 315mm | 250g | 0.2mm | Python/ROS | True 6-axis wrist orientation. |
| **Yahboom DOFBOT** (starter) | ~$289–339 | 6 | 270mm | ~few 100g | n/a | ROS2+Python+OpenCV, **ships w/ camera** | Fastest to prototype the full detect→pick→place loop. |
| Hiwonder xArm 1S (cheapest) | ~$130–160 | 6 | ~350mm | 500g | loose | serial + community Python | Most glue code; loosest accuracy. |

**Recommended:** uArm Swift Pro + DIY magnetic end-effector for the real build; Yahboom DOFBOT to
prototype the vision→pick→place loop cheaply first.

### Integration architecture (phone app → arm)
```
[iPhone app]  vision + UI brain
   detect sockets in bucket + classify size (10mm, 1/2", …)
   identify target slot on the tray (labeled slots)
        │  pick-and-place coordinate list (JSON over local HTTP/websocket)
        ▼
[small host: Raspberry Pi / Jetson / laptop]  runs the arm's Python SDK
   for each socket: set_position(x,y,z) → magnet ON → lift →
                    set_position(target slot x,y,z) → magnet OFF
        ▼
[uArm Swift Pro + magnetic end-effector]
```
- **Calibration:** one-time hand-eye homography from 3–4 known reference points maps camera pixels →
  arm base coordinates. The magnetic tray's known slot geometry (standard tray sizes) gives target
  coordinates without per-slot vision.
- **Phone stays the brain** (vision + the same Qwen3-VL detection the app already does via
  `/detect-spots`); the host is a thin relay. uArm's `set_position(x,y,z)` + GPIO magnet toggle makes
  this the simplest SDK to target; Dobot's Python API is the close second.
- **In-app surface (future):** an "Auto-sort with arm" action on a socket-set that streams detected
  socket→slot coordinates to the host endpoint (mirrors the ContinueOnPhone "link a device" pattern:
  the app pairs with the host over the LAN).

### Biggest risks (ranked)
1. Picking a single socket from a cluttered bucket → **magnet mitigates most**; a pre-singulation
   tray (spread sockets out) removes the rest.
2. Camera↔arm calibration (the main software effort).
3. Vision size-classification (10mm vs 12mm) — leverage the app's existing VLM detection.
4. Calibration drift on cheap servo arms.

### Recommendation
This is a **hardware project gated on buying an arm.** Nothing ships in the app until hardware exists.
Sensible path: (1) buy the Yahboom DOFBOT (~$300, camera included) to prove the detect→pick→place
loop cheaply, or go straight to the uArm Swift Pro (~$749) + magnetic effector for the real build;
(2) build the host relay (Python SDK + local HTTP endpoint); (3) add the in-app "pair + auto-sort"
surface. The app-side vision (socket detection + classification) reuses the existing Qwen3-VL pipeline.

Sources (verify on ASIN pages): uArm Swift Pro, Yahboom DOFBOT, Dobot Magician Lite, WLKATA Mirobot,
Hiwonder xArm 1S on Amazon; uArm-Python-SDK on GitHub.
