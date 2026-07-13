# AI Blueprint Generation + App-Wide UX / Guidance Sweep

Date: 2026-07-13
Status: Approved (brainstorming), moving to implementation

## Goal

Two coupled outcomes in one session:

1. **Feature** — AI-generated blueprints. The user snaps a hand-drawn garage sketch OR types a
   description, and the app produces a to-scale storage blueprint (room size + labeled zones) that
   loads straight into the existing `BlueprintEditor` for review and save.
2. **UX sweep** — make the whole app's flow coherent, replace every bare spinner with one rich,
   animated, self-explaining loading experience, and add a guidance/coaching layer so users
   understand the mental model and how each AI step works.

## Non-goals (YAGNI)

- No training of any model — Qwen3-VL is prompted, not trained.
- No new "walls JSON" representation. The shipped `Blueprint` shape (`roomFt` + `zones`) is the
  single blueprint schema; AI generates into it, reusing all existing draw/render/persist code.
- No CSV import (declined earlier).
- No auto-save of AI output — it always lands in the editor for human review first.

## Part A — Feature: `POST /generate-blueprint`

### Worker (`vision-service/worker.js`)

New route `POST /generate-blueprint` accepting `{ imageDataUrl?, description? }`:

- **This is the only route where `imageDataUrl` is optional.** The global `missing imageDataUrl`
  guard gets a per-route exception; the route instead requires *at least one* of `imageDataUrl` or a
  non-empty `description`, else 400.
- **Sketch-photo path**: VLM reads the hand-drawn sketch (uses the normal vision provider ladder).
- **Text-only path**: no image → `callProvider` omits the `image_url` content part and sends a
  text-only message. Same provider ladder (235B → self-hosted box → free chain).
- **Prompt** returns the `Blueprint` shape directly:
  `{ "roomFt": {"w": ft, "d": ft}, "zones": [{"name", "type", "rect": {"x","y","w","h"}}] }`.
  `type` constrained to the six zone types; rects normalized 0..1 with the room as the frame.
- **Output validation / clamping** (mirrors existing endpoints' rigor):
  - `roomFt.w`, `roomFt.d`: finite, clamped 1–200, fallback 20.
  - `zones`: array, sliced to ≤ 20.
  - each `type ∈ {pegboard, shelf, cabinet, rack, drawer, bin}`, fallback `shelf`.
  - each `rect`: x/y/w/h clamped 0..1; w,h floored to a min (0.05); x+w and y+h clamped ≤ 1.
  - `name`: trimmed string, fallback `Zone N`.

### Client (`src/lib/vision.ts`)

`generateBlueprintFromImage(input: { imageDataUrl?: string; description?: string }): Promise<Blueprint>`
posting to `/generate-blueprint`. Reuse the `Blueprint` interface (import from BlueprintEditor or a
shared type module — see below).

### UI (`BlueprintEditor.tsx`)

- Add a "Generate with AI" affordance at the top of the editor.
- Opens a compact panel with two modes: **Snap sketch** (camera/file → compressed data URL via the
  existing `src/lib/image.ts`) and **Describe it** (textarea).
- On result: pre-populate `roomW`, `roomD`, and `zones` state in the editor. User drags/renames,
  then Saves through the existing `save()`. Nothing downstream changes — `PropertyPlan` already
  renders `layout.blueprint`.

### Shared type

Extract `Blueprint` / `Zone` / `Rect` into `src/lib/blueprint.ts` so both `vision.ts` and
`BlueprintEditor.tsx` import one definition (avoids a circular import from the component).

## Part B — UX Sweep: one shared AI-progress experience

New `src/components/inventory/VisionProgress.tsx`, a reusable component that replaces every bare
`<Loader2 className="animate-spin" /> …` used during an AI call.

- Props: `{ imageDataUrl?: string; stages: string[]; }` (plus standard className).
- **Visual**: if `imageDataUrl` given, render a thumbnail with an animated scanning-line sweep over
  it; otherwise a branded pegboard-dot shimmer block.
- **Stage captions**: cycle through `stages` on a timer (~2s each, holding on the last), so the
  copy teaches what the AI is doing. Per-call stage sets, e.g.:
  - map-space: `["Looking at your photo", "Finding the storage unit", "Counting rows & columns", "Placing the grid"]`
  - detect-spots: `["Scanning the surface", "Finding each tool", "Boxing every spot"]`
  - identify-bin: `["Opening the bin", "Reading labels", "Listing every item"]`
  - identify-item: `["Focusing on the tool", "Reading brand & model", "Looking it up"]`
  - generate-blueprint: `["Reading your sketch", "Measuring the room", "Placing storage zones"]`
- **Honest long-wait line**: after ~15s elapsed, append "The self-hosted model is thinking — this
  can take up to a minute." (matches real 60–90s fallback latency).
- **Reduced-motion**: no sweeping/shimmer when `prefers-reduced-motion`; falls back to a calm
  pulsing dot + the (still-cycling) captions.

Wire into: `MapSpaceDialog`, `BinFillDialog`, `ImageRecognition`, the detect-spots flow, and the new
blueprint generator.

## Part C — UX Sweep: guidance / coaching layer

- **`src/components/inventory/GuideTip.tsx`** — a small dismissible inline hint (icon + text, optional
  "Got it"), used in empty states and first-time moments. Dismissal persisted per key in
  `localStorage` (`tv-tip:<key>`), matching the onboarding-persistence convention.
- **"How it works" overlay** — reachable any time from a header/Settings "?" entry. Reuses and
  extends the existing `Onboarding` content into an always-available explainer of the mental model:
  **Space → Location → Slot/Bin**, plus what each AI action does. Implemented so the same content
  powers first-run onboarding and the on-demand overlay (one source of truth).
- **Transition consistency**: apply existing `animate-in-up` / `stagger` / `animate-pop` to list and
  dialog mounts that currently appear without motion.

## Part D — Coherence audit (verification-driven)

Run the app in the browser (Chrome MCP / dev server) and walk the core flow end-to-end:
add space → add location → map with camera → fill a bin → scan a QR → generate/edit a blueprint.
Fix rough edges found; confirm the flow reads sensibly rather than asserting it. Log findings.

## Build order

A (feature: worker → client → editor UI) → B (shared progress, retrofit all five AI calls) →
C (guidance layer) → D (audit + fixes). Feature branch `feat/ai-blueprint-ux-sweep`; single PR.

## Testing

- Worker: unit-test the new output-clamping/normalization logic (roomFt bounds, zone cap, type
  fallback, rect clamping) — pure functions, no network.
- Client + UI: verify against the running app in Part D (real endpoint, real render), since these are
  view/integration concerns.

## Risks / notes

- Text-only path depends on the lead model accepting an image-less message; the ladder's free/text
  models handle text fine. If the 235B vision route rejects no-image calls, fall through works.
- Long AI latency is a UX (not correctness) risk — Part B's honest wait copy is the mitigation.
- Editing a component mid-browser-test triggers Vite HMR state reset (known gotcha) — don't edit
  during a stateful test.
