#!/usr/bin/env bash
# One-line install + run for the Tool Vision desktop connector (printer + webcam bridge).
#
#   curl -fsSL https://raw.githubusercontent.com/zohebzma2-cmyk/tool-vision-inventory/main/desktop-connector/install.sh | bash
#
# It sets up a self-contained venv under ~/.tool-vision-connector, installs the Python deps, fetches
# the latest connector, and starts it on http://127.0.0.1:17777 (the address the app links to).
# Re-running it updates the connector to the latest version. Safe to run again any time.
set -euo pipefail

REPO_RAW="https://raw.githubusercontent.com/zohebzma2-cmyk/tool-vision-inventory/main/desktop-connector"
DIR="$HOME/.tool-vision-connector"

echo "→ Tool Vision connector: setting up in $DIR"
mkdir -p "$DIR"
cd "$DIR"

if ! command -v python3 >/dev/null 2>&1; then
  echo "✗ python3 not found. Install it (e.g. 'brew install python') and re-run." >&2
  exit 1
fi

echo "→ Fetching the latest connector…"
curl -fsSL "$REPO_RAW/connector.py" -o connector.py

if [ ! -d venv ]; then
  echo "→ Creating a Python environment…"
  python3 -m venv venv
fi

echo "→ Installing dependencies (printer, imaging)…"
./venv/bin/pip install --quiet --upgrade pip brother_ql pyusb pillow

# Optional extras for desktop Rapid Mode (webcam capture + hands-free voice). Best-effort — the
# connector runs fine without them; only Rapid Mode's camera/voice need them.
if command -v brew >/dev/null 2>&1; then
  echo "→ (optional) ffmpeg + whisper for webcam/voice — best effort…"
  brew list ffmpeg      >/dev/null 2>&1 || brew install ffmpeg      >/dev/null 2>&1 || true
  brew list whisper-cpp >/dev/null 2>&1 || brew install whisper-cpp >/dev/null 2>&1 || true
fi

echo ""
echo "✓ Ready. Starting the connector on http://127.0.0.1:17777"
echo "  Leave this window open while you use the app. Press Ctrl-C to stop."
echo ""
exec ./venv/bin/python connector.py
