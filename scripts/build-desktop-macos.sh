#!/bin/bash
set -euo pipefail

# Independent native artifact; never writes the server's release asset names.
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Build Tessera Desktop on macOS with Xcode Command Line Tools installed." >&2
  exit 1
fi
cd "$(dirname "$0")/.."
version="${VERSION:-0.0.0-dev}"
bundle_version="${version#v}"
bundle_version="${bundle_version%%[-+]*}"
if [[ ! "$bundle_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then bundle_version=0.0.0; fi
arch="${GOARCH:-$(go env GOARCH)}"
case "$arch" in arm64|amd64) ;; *) echo "Unsupported macOS architecture: $arch" >&2; exit 1 ;; esac
if [[ ! "$version" =~ ^[a-zA-Z0-9.+_-]+$ ]]; then
  echo "VERSION must contain only letters, digits, dots, +, _, and -." >&2
  exit 1
fi
output="$(pwd)/bin/desktop/$arch"
bundle="$output/Tessera Desktop.app"
mkdir -p "$bundle/Contents/MacOS" "$bundle/Contents/Resources"
export MACOSX_DEPLOYMENT_TARGET=12.0
CGO_ENABLED=1 GOOS=darwin GOARCH="$arch" go build -tags desktop -trimpath \
  -ldflags "-s -w -X tessera/internal/version.Version=$version" \
  -o "$bundle/Contents/MacOS/tessera-desktop" ./cmd/tessera-desktop

cat > "$bundle/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>io.github.umpecca.tessera.desktop</string>
  <key>CFBundleName</key><string>Tessera Desktop</string>
  <key>CFBundleDisplayName</key><string>Tessera Desktop</string>
  <key>CFBundleExecutable</key><string>tessera-desktop</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>$bundle_version</string>
  <key>CFBundleIconFile</key><string>Tessera.icns</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSAppTransportSecurity</key><dict>
    <key>NSAllowsLocalNetworking</key><true/>
    <key>NSAllowsArbitraryLoadsInWebContent</key><true/>
  </dict>
</dict></plist>
EOF

iconset="$output/Tessera.iconset"
mkdir -p "$iconset"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" web/assets/tessera-app-icon-512.png --out "$iconset/icon_${size}x${size}.png" >/dev/null
  if [[ "$size" -lt 512 ]]; then
    double=$((size * 2))
    sips -z "$double" "$double" web/assets/tessera-app-icon-512.png --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
  fi
done
iconutil -c icns "$iconset" -o "$bundle/Contents/Resources/Tessera.icns"
plutil -lint "$bundle/Contents/Info.plist"
# This is a local preview, not a notarized public distribution. A future signed
# release needs its own hardened-runtime/entitlement and notarization validation.
codesign --force --sign - "$bundle"
codesign --verify --strict "$bundle"
archive="$output/tessera-desktop-darwin-$arch.zip"
ditto -c -k --sequesterRsrc --keepParent "$bundle" "$archive"
echo "Built $bundle"
echo "Packaged $archive"
