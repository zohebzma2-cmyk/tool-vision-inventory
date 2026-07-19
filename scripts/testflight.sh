#!/usr/bin/env bash
# Build, sign, and upload the iOS app to TestFlight in one run.
#
# Usage:  bash scripts/testflight.sh
#
# Requirements:
#   - Xcode + an App Store Connect API key (.p8) with App Manager access
#   - The app record must exist in App Store Connect (created once, by hand:
#     My Apps -> + -> New App -> iOS, matching BUNDLE_ID below)
#
# Signing is fully automatic ("cloud signing"): xcodebuild uses the API key to
# register the bundle id and mint certificates/profiles on demand — nothing
# needs to be in the local keychain.
set -euo pipefail

ASC_KEY_ID="${ASC_KEY_ID:-63QZBPT76J}"
ASC_KEY_PATH="${ASC_KEY_PATH:-$HOME/.private-keys/AuthKey_${ASC_KEY_ID}.p8}"
ASC_ISSUER_ID="${ASC_ISSUER_ID:-4d3d9179-5432-46c9-aeea-f24c6b0dbed6}"
TEAM_ID="${TEAM_ID:-N73PWGVQJ6}"
BUNDLE_ID="${BUNDLE_ID:-app.toolvision.inventory}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$ROOT/ios/build"
ARCHIVE="$BUILD_DIR/ToolVision.xcarchive"

[ -f "$ASC_KEY_PATH" ] || { echo "ERROR: API key not found at $ASC_KEY_PATH"; exit 1; }

echo "==> 1/4 Checking the App Store Connect app record for $BUNDLE_ID"
JWT=$(python3 - "$ASC_KEY_PATH" "$ASC_KEY_ID" "$ASC_ISSUER_ID" <<'PYEOF'
import base64, json, sys, time
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
b64 = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=").decode()
p8, kid, iss = sys.argv[1], sys.argv[2], sys.argv[3]
key = serialization.load_pem_private_key(open(p8, "rb").read(), password=None)
now = int(time.time())
si = f'{b64(json.dumps({"alg":"ES256","kid":kid,"typ":"JWT"}).encode())}.{b64(json.dumps({"iss":iss,"iat":now,"exp":now+1140,"aud":"appstoreconnect-v1"}).encode())}'
r, s = decode_dss_signature(key.sign(si.encode(), ec.ECDSA(hashes.SHA256())))
print(f"{si}.{b64(r.to_bytes(32,'big')+s.to_bytes(32,'big'))}")
PYEOF
)
APP_CHECK=$(curl -s -H "Authorization: Bearer $JWT" \
  "https://api.appstoreconnect.apple.com/v1/apps?filter%5BbundleId%5D=$BUNDLE_ID")
if ! echo "$APP_CHECK" | grep -q '"id"'; then
  echo ""
  echo "WARNING: no App Store Connect app record found for $BUNDLE_ID."
  echo "Create it once at https://appstoreconnect.apple.com -> My Apps -> + -> New App"
  echo "  (iOS, name 'Tool Vision', bundle $BUNDLE_ID, SKU tool-vision-1)"
  echo "The archive will still build; the final upload step will fail until the record exists."
  echo ""
fi

echo "==> 2/4 Building the web app and syncing into the iOS project"
cd "$ROOT"
npm run build
npx cap sync ios

echo "==> 3/4 Archiving (cloud signing via ASC API key — no keychain certs needed)"
# Auto-increment the build number so each upload is unique (App Store Connect rejects duplicates).
# The git commit count is monotonic and always higher than any past manual number.
BUILD_NO=$(git rev-list --count HEAD)
echo "    build number: $BUILD_NO"
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Release \
  -sdk iphoneos -archivePath "$ARCHIVE" archive \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration \
  -authenticationKeyPath "$ASC_KEY_PATH" \
  -authenticationKeyID "$ASC_KEY_ID" \
  -authenticationKeyIssuerID "$ASC_ISSUER_ID" \
  CURRENT_PROJECT_VERSION="$BUILD_NO" \
  DEVELOPMENT_TEAM="$TEAM_ID" | tail -3

echo "==> 4/4 Exporting and uploading to App Store Connect"
EXPORT_PLIST="$BUILD_DIR/exportOptions.plist"
cat > "$EXPORT_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key><string>app-store-connect</string>
    <key>destination</key><string>upload</string>
    <key>signingStyle</key><string>automatic</string>
    <key>teamID</key><string>$TEAM_ID</string>
    <key>uploadSymbols</key><true/>
    <key>manageAppVersionAndBuildNumber</key><true/>
</dict>
</plist>
PLIST
xcodebuild -exportArchive -archivePath "$ARCHIVE" \
  -exportOptionsPlist "$EXPORT_PLIST" -exportPath "$BUILD_DIR/export" \
  -allowProvisioningUpdates \
  -authenticationKeyPath "$ASC_KEY_PATH" \
  -authenticationKeyID "$ASC_KEY_ID" \
  -authenticationKeyIssuerID "$ASC_ISSUER_ID" | tail -5

echo ""
echo "Done. The build is processing — it appears in TestFlight (App Store Connect"
echo "-> Tool Vision -> TestFlight) within ~5-15 minutes. As Account Holder you can"
echo "install it from the TestFlight app on any of your devices once it finishes."
