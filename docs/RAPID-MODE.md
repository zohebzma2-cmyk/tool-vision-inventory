# Rapid Mode & Find Mode — the hands-free labeling station

Two voice-driven surfaces let you inventory and locate tools without typing. Both run on the desktop
station (a Mac with the Logitech webcam + Brother QL-800) and in the iOS app (device camera, reaching
the Mac over Wi-Fi).

## Rapid Mode — label a bin hands-free

Open a bin (**Storage → pick a bin → Rapid Mode**). The webcam turns on. Present tools one at a time:

1. Hold a tool steady to the camera — it auto-captures when the image settles.
2. The assistant **speaks** what it sees ("DeWalt chalk line. Say yes to label it, skip to pass, or done to finish.").
3. Answer by voice:
   - **"yes"** (optionally "yes two") → mints a code, files the item in this bin *with its photo*, prints a barcode label. `"yes two"` sets quantity 2.
   - **"skip"** → pass on this item.
   - **"no, it's a torque wrench"** → relabels with the corrected name, then files it.
   - **"undo"** / "remove last" → deletes the item you just added.
   - **"done"** → finish.
4. Presenting a tool that's **already in the bin** bumps its quantity instead of duplicating.
5. **Closing the bin prints its categorized bin label** (it adopts the most common item category if the bin had none).

If the printer is asleep or the connector is down, labels are **queued and retried automatically** — nothing is lost. See the pending count in **Settings**.

## Find Mode — "where's my …?"

Tap **Find** in the header. Ask out loud ("where's my chalk line") and it tells you the bin and highlights the match, listening for the next question until you say "done". A **text box** is the fallback when voice isn't available (e.g. the hosted site can't reach the local connector).

## How the voice works (local, no cloud, no metered cost)

- **Speech → text**: the browser records a short mic clip and POSTs it to the desktop connector's `POST /transcribe`, which runs **whisper.cpp** locally (`whisper-cli` + `ffmpeg`, model `~/.tool-vision-connector/ggml-base.en.bin`).
- **Text → speech**: the browser's built-in SpeechSynthesis (spoken captions are shown on screen too).
- Both reach the connector over the LAN, so the **iOS app transcribes on the Mac** just like it prints there.

## Requirements / gotchas

- Use the **connector-served app** at `http://localhost:17777` on the Mac station (localhost is a secure context and same-origin with the connector). The hosted `tool-vision.pages.dev` can't reach `localhost` for voice/print — voice there falls back to the text box.
- The **tape loaded must match** Settings → Tape / label size (the QL-800 can't report its tape).
- iOS needs the microphone permission (shipped) and a fresh TestFlight build to pick up Rapid/Find Mode.
- Install to the home screen (PWA) for a full-screen station that survives Wi-Fi blips.
