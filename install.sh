#!/usr/bin/env bash
# Zimika Linux installer. No sudo needed: installs into ~/.local.
set -euo pipefail

REPO="agnogad/zimika"
BINARY="zimika-linux-x86_64"
BIN_DIR="${ZIMIKA_INSTALL_DIR:-$HOME/.local/bin}"
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}"
APP_DIR="$DATA_DIR/applications"
ICON_DIR="$DATA_DIR/icons/hicolor/scalable/apps"
DESKTOP="$APP_DIR/zimika.desktop"
ICON="$ICON_DIR/zimika.svg"
URL="https://github.com/$REPO/releases/latest/download/$BINARY"

info() { printf '\033[1;33m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

uninstall() {
  info "Removing Zimika from $BIN_DIR"
  rm -f "$BIN_DIR/zimika" "$DESKTOP" "$ICON"
  ok "Uninstalled. Your settings and cache in ~/.local/share/zimika were kept."
  exit 0
}

if [[ "${1:-}" == "--uninstall" ]]; then uninstall; fi

command -v curl >/dev/null 2>&1 || die "curl is required to install Zimika"

case "$(uname -m)" in
  x86_64|amd64) ;;
  aarch64|arm64) die "No ARM64 release asset yet. Build from source with: zig build install -Doptimize=ReleaseSafe" ;;
  *) die "Unsupported architecture: $(uname -m)" ;;
esac

mkdir -p "$BIN_DIR" "$APP_DIR" "$ICON_DIR"
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

info "Downloading $BINARY"
curl -fL --progress-bar "${ZIMIKA_BINARY_URL:-$URL}" -o "$TMP" || die "Download failed"
[[ -s "$TMP" ]] || die "Downloaded file is empty"
chmod 755 "$TMP"
mv "$TMP" "$BIN_DIR/zimika"

info "Installing desktop entry and icon"
# The icon comes from the tagged source so it matches the release.
curl -fsSL "https://raw.githubusercontent.com/$REPO/main/docs/logo.svg" -o "$ICON" || true
cat > "$DESKTOP" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=Zimika
Comment=Lightweight desktop music player
Exec=$BIN_DIR/zimika
Icon=zimika
Terminal=false
Categories=AudioVideo;Audio;Player;Music;
StartupNotify=true
EOF
chmod +x "$DESKTOP"
update-desktop-database "$APP_DIR" 2>/dev/null || true

ok "Zimika installed to $BIN_DIR/zimika"
if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  info "Add this to your shell profile to run 'zimika' directly:"
  printf '  export PATH="%s:$PATH"\n' "$BIN_DIR"
fi
info "Run it now with: $BIN_DIR/zimika"
