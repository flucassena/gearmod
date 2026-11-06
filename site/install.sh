#!/bin/sh
# GearMod installer for Linux (x64).
# Downloads the latest release from GitHub, checks it against the release's SHA256SUMS.txt and installs it.
#
#   curl -fsSL https://gearmod.dev/install.sh | sh                      # .deb on Debian/Ubuntu, AppImage elsewhere
#   curl -fsSL https://gearmod.dev/install.sh | sh -s -- --appimage     # AppImage in your home folder, no sudo
#   curl -fsSL https://gearmod.dev/install.sh | sh -s -- --deb          # .deb through apt (asks for sudo)
#   curl -fsSL https://gearmod.dev/install.sh | sh -s -- --version v0.2.0
#   curl -fsSL https://gearmod.dev/install.sh | sh -s -- --uninstall
#
# Running it again updates GearMod. Your data (~/.config/GearMod) is never touched, not even by --uninstall.
set -eu

REPO="flucassena/gearmod"
API="${GEARMOD_API:-https://api.github.com/repos/$REPO/releases}"
ICON_URL="${GEARMOD_ICON_URL:-https://gearmod.dev/assets/logo.png}"
APP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/gearmod"
BIN_DIR="$HOME/.local/bin"
DESKTOP_FILE="${XDG_DATA_HOME:-$HOME/.local/share}/applications/gearmod.desktop"

say() { printf '%s\n' "$*"; }
fail() { printf 'gearmod install: %s\n' "$*" >&2; exit 1; }

mode=auto
version=latest
while [ $# -gt 0 ]; do
  case "$1" in
    --deb) mode=deb ;;
    --appimage) mode=appimage ;;
    --uninstall) mode=uninstall ;;
    --version) [ $# -ge 2 ] || fail "--version needs a tag, for example --version v0.2.0"; version="$2"; shift ;;
    -h|--help) say "Usage: install.sh [--deb | --appimage] [--version <tag>] | --uninstall"; say "Without options: .deb on Debian/Ubuntu (through apt), AppImage in your home folder elsewhere."; exit 0 ;;
    *) fail "unknown option: $1 (use --deb, --appimage, --version <tag> or --uninstall)" ;;
  esac
  shift
done

# Root runs apt directly; anyone else goes through sudo, when there is one.
sudo_cmd() {
  if [ "$(id -u)" -eq 0 ]; then "$@"
  elif command -v sudo >/dev/null 2>&1; then sudo "$@"
  else fail "this step needs root and sudo was not found: run it as root or use --appimage"
  fi
}

remove_appimage() {
  rm -f "$APP_DIR/GearMod.AppImage" "$APP_DIR/icon.png" "$DESKTOP_FILE"
  [ -L "$BIN_DIR/gearmod" ] && rm -f "$BIN_DIR/gearmod"
  rmdir "$APP_DIR" 2>/dev/null || true
}

if [ "$mode" = uninstall ]; then
  removed=no
  if [ -e "$APP_DIR/GearMod.AppImage" ] || [ -e "$DESKTOP_FILE" ]; then remove_appimage; removed=yes; say "Removed the AppImage install from $APP_DIR."; fi
  if command -v dpkg >/dev/null 2>&1 && dpkg -s gearmod >/dev/null 2>&1; then sudo_cmd apt-get remove -y gearmod; removed=yes; fi
  [ "$removed" = yes ] || say "GearMod is not installed by this script or by apt."
  say "Your data in ~/.config/GearMod was kept. Delete that folder to remove it too."
  exit 0
fi

[ "$(uname -s)" = Linux ] || fail "this installer is for Linux. Download GearMod for other systems at https://gearmod.dev"
case "$(uname -m)" in
  x86_64|amd64) ;;
  *) fail "GearMod for Linux is only built for x64 (this machine is $(uname -m))" ;;
esac

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL --retry 2 -o "$2" "$1"; }
  fetch_text() { curl -fsSL --retry 2 -H 'Accept: application/vnd.github+json' "$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -q -O "$2" "$1"; }
  fetch_text() { wget -q -O - --header='Accept: application/vnd.github+json' "$1"; }
else
  fail "curl or wget is needed to download GearMod"
fi
command -v sha256sum >/dev/null 2>&1 || fail "sha256sum is needed to check the download (package coreutils)"

if [ "$mode" = auto ]; then
  if command -v apt-get >/dev/null 2>&1 && command -v dpkg >/dev/null 2>&1; then mode=deb; else mode=appimage; fi
fi
case "$mode" in deb) suffix='-amd64.deb' ;; *) suffix='-x86_64.AppImage' ;; esac

if [ "$version" = latest ]; then url="$API/latest"; else url="$API/tags/$version"; fi
say "Looking up GearMod $version on GitHub..."
release=$(fetch_text "$url") || fail "could not read the release from GitHub ($url)"
tag=$(printf '%s' "$release" | grep -o '"tag_name": *"[^"]*"' | head -n 1 | sed 's/.*"\([^"]*\)"$/\1/')
urls=$(printf '%s' "$release" | grep -o '"browser_download_url": *"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/')
package_url=$(printf '%s\n' "$urls" | grep -F -- "$suffix" | head -n 1 || true)
sums_url=$(printf '%s\n' "$urls" | grep -F 'SHA256SUMS.txt' | head -n 1 || true)
[ -n "$package_url" ] || fail "release ${tag:-$version} has no Linux package ($suffix). See https://github.com/$REPO/releases"
[ -n "$sums_url" ] || fail "release ${tag:-$version} has no SHA256SUMS.txt, so the download cannot be checked"
name=${package_url##*/}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM
say "Downloading $name..."
fetch "$package_url" "$tmp/$name" || fail "download failed: $package_url"
fetch "$sums_url" "$tmp/SHA256SUMS.txt" || fail "download failed: $sums_url"
expected=$(awk -v file="$name" '$2 == file || $2 == "*" file { print $1; exit }' "$tmp/SHA256SUMS.txt")
[ -n "$expected" ] || fail "$name is not listed in SHA256SUMS.txt"
actual=$(sha256sum "$tmp/$name" | cut -d ' ' -f 1)
[ "$actual" = "$expected" ] || fail "checksum mismatch for $name: the download is corrupted or was changed. Nothing was installed"
say "Checksum OK."

if [ "$mode" = deb ]; then
  say "Installing with apt (this asks for your password)..."
  chmod 644 "$tmp/$name"
  # apt reads the file as the _apt user: the temporary folder must be readable by it.
  chmod 755 "$tmp"
  sudo_cmd apt-get install -y "$tmp/$name"
  # A previous AppImage install would show up twice in the menu.
  [ -e "$DESKTOP_FILE" ] && remove_appimage
  say ""
  say "GearMod $tag is installed. Open it from the applications menu or run: gearmod"
  exit 0
fi

mkdir -p "$APP_DIR" "$BIN_DIR" "$(dirname "$DESKTOP_FILE")"
mv -f "$tmp/$name" "$APP_DIR/GearMod.AppImage.new"
chmod 755 "$APP_DIR/GearMod.AppImage.new"
mv -f "$APP_DIR/GearMod.AppImage.new" "$APP_DIR/GearMod.AppImage"
ln -sf "$APP_DIR/GearMod.AppImage" "$BIN_DIR/gearmod"
icon_line=""
if fetch "$ICON_URL" "$APP_DIR/icon.png" 2>/dev/null; then icon_line="Icon=$APP_DIR/icon.png"; fi
cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=GearMod
Comment=Kanban board that runs AI coding agents on each card
Exec="$APP_DIR/GearMod.AppImage" %U
$icon_line
Terminal=false
Categories=Development;
StartupWMClass=GearMod
EOF
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q "$(dirname "$DESKTOP_FILE")" 2>/dev/null || true

say ""
say "GearMod $tag is installed in $APP_DIR."
say "Open it from the applications menu or run: gearmod"
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) say "Note: $BIN_DIR is not in your PATH, so 'gearmod' only works after you add it (or open GearMod from the menu)." ;; esac
# AppImages need FUSE 2 to start.
if ! { ldconfig -p 2>/dev/null || /sbin/ldconfig -p 2>/dev/null; } | grep -q 'libfuse\.so\.2'; then
  say "Note: libfuse2 was not found and the AppImage needs it. Install it (Ubuntu 24.04: sudo apt install libfuse2t64; Fedora: sudo dnf install fuse-libs)"
  say "      or start GearMod with: $APP_DIR/GearMod.AppImage --appimage-extract-and-run"
fi
