#!/usr/bin/env bash
#
# One-shot setup for hosting the Tool Vision Inventory AI on a Mac mini.
# Installs Ollama + a vision model, runs the zero-dep adapter as a login service,
# and (optionally) exposes it publicly via a Cloudflare Tunnel.
#
# Usage:
#   scripts/setup-mac-mini.sh                         # install Ollama + adapter (auto-pick model by RAM)
#   VISION_MODEL=qwen2.5vl:3b scripts/setup-mac-mini.sh
#   TUNNEL_HOSTNAME=vision.example.com scripts/setup-mac-mini.sh   # also set up the public tunnel
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ADAPTER_DIR="$REPO_ROOT/vision-service"

VISION_PORT="${VISION_PORT:-8787}"
OLLAMA_URL="${OLLAMA_URL:-http://127.0.0.1:11434}"
TUNNEL_HOSTNAME="${TUNNEL_HOSTNAME:-}"
TUNNEL_NAME="${TUNNEL_NAME:-tool-vision}"

log() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

# --- 0. Sanity ----------------------------------------------------------------
[ "$(uname)" = "Darwin" ] || die "This script is for macOS."
ARCH="$(uname -m)"
if [ "$ARCH" != "arm64" ]; then
  warn "Detected Intel Mac ($ARCH). Vision inference will run on CPU and be slow. Apple Silicon strongly recommended."
fi

# Pick a model by installed RAM if the caller didn't specify one.
RAM_GB="$(( $(sysctl -n hw.memsize) / 1024 / 1024 / 1024 ))"
if [ -z "${VISION_MODEL:-}" ]; then
  if [ "$RAM_GB" -ge 16 ]; then VISION_MODEL="qwen2.5vl:7b"; else VISION_MODEL="qwen2.5vl:3b"; fi
fi
log "Mac: ${ARCH}, ${RAM_GB} GB RAM. Model: ${VISION_MODEL}. Adapter port: ${VISION_PORT}."

# --- 1. Homebrew --------------------------------------------------------------
if ! command -v brew >/dev/null 2>&1; then
  log "Installing Homebrew..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  # Load brew into this shell (Apple Silicon path).
  eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv)"
fi

# --- 2. Node, Ollama, cloudflared --------------------------------------------
log "Installing node, ollama, cloudflared (skips any already present)..."
for pkg in node ollama cloudflared; do
  brew list "$pkg" >/dev/null 2>&1 || brew install "$pkg"
done

log "Starting Ollama as a background service..."
brew services start ollama >/dev/null 2>&1 || ollama serve >/dev/null 2>&1 &
# Wait for Ollama to answer.
for i in $(seq 1 30); do
  curl -fsS "$OLLAMA_URL/api/tags" >/dev/null 2>&1 && break
  sleep 1
  [ "$i" = "30" ] && die "Ollama did not come up on $OLLAMA_URL"
done

log "Pulling vision model ${VISION_MODEL} (this is the slow part; grab a coffee)..."
ollama pull "$VISION_MODEL"

# --- 3. Adapter as a LaunchAgent ---------------------------------------------
NODE_BIN="$(command -v node)"
LOG_DIR="$HOME/Library/Logs/tool-vision"
mkdir -p "$LOG_DIR"
PLIST="$HOME/Library/LaunchAgents/com.toolvision.adapter.plist"
log "Installing adapter LaunchAgent -> $PLIST"
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.toolvision.adapter</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${ADAPTER_DIR}/server.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>${ADAPTER_DIR}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>VISION_PORT</key><string>${VISION_PORT}</string>
    <key>VISION_MODEL</key><string>${VISION_MODEL}</string>
    <key>OLLAMA_URL</key><string>${OLLAMA_URL}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${LOG_DIR}/adapter.log</string>
  <key>StandardErrorPath</key><string>${LOG_DIR}/adapter.err.log</string>
</dict>
</plist>
PLIST_EOF

launchctl unload "$PLIST" >/dev/null 2>&1 || true
launchctl load -w "$PLIST"

# Health check the adapter.
for i in $(seq 1 15); do
  curl -fsS "http://127.0.0.1:${VISION_PORT}/health" >/dev/null 2>&1 && break
  sleep 1
  [ "$i" = "15" ] && warn "Adapter health check timed out; see ${LOG_DIR}/adapter.err.log"
done
log "Adapter health: $(curl -fsS "http://127.0.0.1:${VISION_PORT}/health" || echo 'no response')"

# --- 4. Cloudflare Tunnel (optional) -----------------------------------------
if [ -n "$TUNNEL_HOSTNAME" ]; then
  log "Setting up Cloudflare Tunnel for https://${TUNNEL_HOSTNAME}"
  if [ ! -f "$HOME/.cloudflared/cert.pem" ]; then
    warn "Browser step: a URL will open. Log in and authorize the domain that owns ${TUNNEL_HOSTNAME}."
    cloudflared tunnel login
  fi
  cloudflared tunnel create "$TUNNEL_NAME" 2>/dev/null || log "Tunnel ${TUNNEL_NAME} already exists."
  CRED_FILE="$(ls -t "$HOME"/.cloudflared/*.json 2>/dev/null | head -1)"
  [ -n "$CRED_FILE" ] || die "Could not find tunnel credentials file in ~/.cloudflared"

  cat > "$HOME/.cloudflared/config.yml" <<CFG_EOF
tunnel: ${TUNNEL_NAME}
credentials-file: ${CRED_FILE}
ingress:
  - hostname: ${TUNNEL_HOSTNAME}
    service: http://localhost:${VISION_PORT}
  - service: http_status:404
CFG_EOF

  cloudflared tunnel route dns "$TUNNEL_NAME" "$TUNNEL_HOSTNAME" 2>/dev/null || true

  CF_PLIST="$HOME/Library/LaunchAgents/com.toolvision.cloudflared.plist"
  CF_BIN="$(command -v cloudflared)"
  cat > "$CF_PLIST" <<CF_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.toolvision.cloudflared</string>
  <key>ProgramArguments</key>
  <array>
    <string>${CF_BIN}</string>
    <string>tunnel</string>
    <string>--config</string>
    <string>${HOME}/.cloudflared/config.yml</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${LOG_DIR}/cloudflared.log</string>
  <key>StandardErrorPath</key><string>${LOG_DIR}/cloudflared.err.log</string>
</dict>
</plist>
CF_EOF
  launchctl unload "$CF_PLIST" >/dev/null 2>&1 || true
  launchctl load -w "$CF_PLIST"
  log "Tunnel running. Public endpoint: https://${TUNNEL_HOSTNAME}"
  echo
  log "Set this in the frontend env (Cloudflare Pages):"
  echo "    VITE_VISION_API_URL=https://${TUNNEL_HOSTNAME}"
else
  echo
  log "Adapter is live locally at http://127.0.0.1:${VISION_PORT}"
  warn "No TUNNEL_HOSTNAME given, so it is not public yet. Re-run with e.g.:"
  echo "    TUNNEL_HOSTNAME=vision.yourdomain.com scripts/setup-mac-mini.sh"
fi

echo
log "Done. Manage services with: launchctl {unload|load -w} ~/Library/LaunchAgents/com.toolvision.*.plist"
log "Logs: ${LOG_DIR}/"
