#!/usr/bin/env bash
# One-line setup for the Tool Vision desktop connector (printer + webcam bridge).
#
#   curl -fsSL https://raw.githubusercontent.com/zohebzma2-cmyk/tool-vision-inventory/main/desktop-connector/install.sh | bash
#
# Run it ONCE on the Mac that has the label printer. It installs a self-contained environment under
# ~/.tool-vision-connector, then registers a LaunchAgent so the connector starts automatically every
# time the Mac boots, keeps itself alive, and opens the app in the browser — no Terminal, no URLs, no
# babysitting. Re-running it updates the connector to the latest and is always safe.
set -euo pipefail

REPO_RAW="https://raw.githubusercontent.com/zohebzma2-cmyk/tool-vision-inventory/main/desktop-connector"
DIR="$HOME/.tool-vision-connector"
LABEL="com.toolvision.connector"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

echo "→ Tool Vision connector: setting up in $DIR"
mkdir -p "$DIR"; cd "$DIR"

command -v python3 >/dev/null 2>&1 || { echo "✗ python3 not found. Install it (e.g. 'brew install python') and re-run." >&2; exit 1; }

echo "→ Fetching the latest connector…"
curl -fsSL "$REPO_RAW/connector.py" -o connector.py
[ -d venv ] || { echo "→ Creating a Python environment…"; python3 -m venv venv; }
echo "→ Installing dependencies…"
./venv/bin/pip install --quiet --upgrade pip brother_ql pyusb pillow

# Optional extras for desktop Rapid Mode (webcam + hands-free voice) — best effort.
if command -v brew >/dev/null 2>&1; then
  brew list ffmpeg      >/dev/null 2>&1 || brew install ffmpeg      >/dev/null 2>&1 || true
  brew list whisper-cpp >/dev/null 2>&1 || brew install whisper-cpp >/dev/null 2>&1 || true
fi

# Stop anything already running on the port (a foreground run or an older agent) so the new one binds.
launchctl unload "$PLIST" 2>/dev/null || true
pkill -f "$DIR/connector.py" 2>/dev/null || true
sleep 1

echo "→ Registering auto-start (LaunchAgent)…"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$DIR/venv/bin/python</string>
    <string>$DIR/connector.py</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>StandardOutPath</key><string>$DIR/connector.log</string>
  <key>StandardErrorPath</key><string>$DIR/connector.log</string>
</dict>
</plist>
PLISTEOF

launchctl load -w "$PLIST"
sleep 2
echo ""
echo "✓ Done. The connector is running and will start automatically every time this Mac boots."
echo "  It opens the app for you — nothing else to do. Logs: $DIR/connector.log"
