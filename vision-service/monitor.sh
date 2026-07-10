#!/usr/bin/env sh
#
# monitor.sh - quick uptime check for the vision Worker and the app.
#
# Checks the Worker /health endpoint and the app URL. Prints the status of each
# and exits non-zero if either is down (non-2xx, timeout, or connection error).
#
# Usage:
#   ./monitor.sh <vision_health_url> <app_url>
#   VISION_HEALTH_URL=... APP_URL=... ./monitor.sh
#
# Positional arguments take precedence over the environment variables.
# Examples:
#   ./monitor.sh https://vision.example.workers.dev/health https://tools.example.com/
#   VISION_HEALTH_URL=https://vision.example.workers.dev/health \
#     APP_URL=https://tools.example.com/ ./monitor.sh
#
# Intended to be run ad hoc or from cron. See docs/RELIABILITY.md.

set -eu

VISION_HEALTH_URL="${1:-${VISION_HEALTH_URL:-}}"
APP_URL="${2:-${APP_URL:-}}"

if [ -z "$VISION_HEALTH_URL" ] || [ -z "$APP_URL" ]; then
  echo "usage: $0 <vision_health_url> <app_url>" >&2
  echo "   or: VISION_HEALTH_URL=... APP_URL=... $0" >&2
  exit 2
fi

# check_url NAME URL -> prints status, returns 0 if 2xx else 1
check_url() {
  name="$1"
  url="$2"
  code=$(curl -sS -o /dev/null -w "%{http_code}" \
    --max-time 30 --retry 2 --retry-delay 3 \
    "$url" 2>/dev/null) || code="000"
  case "$code" in
    2*)
      echo "UP    $name ($url) -> HTTP $code"
      return 0
      ;;
    000)
      echo "DOWN  $name ($url) -> no response (timeout/connection error)"
      return 1
      ;;
    *)
      echo "DOWN  $name ($url) -> HTTP $code"
      return 1
      ;;
  esac
}

rc=0

if ! check_url "vision worker /health" "$VISION_HEALTH_URL"; then
  rc=1
fi

if ! check_url "app" "$APP_URL"; then
  rc=1
fi

if [ "$rc" -eq 0 ]; then
  echo "OK: all endpoints healthy"
else
  echo "FAIL: one or more endpoints are down" >&2
fi

exit "$rc"
