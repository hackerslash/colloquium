#!/usr/bin/env bash
# Build the minimal LGPL ffmpeg + ffprobe sidecars that Colloquium ships.
#
# Why we build these instead of downloading a prebuilt:
#
#   * Licensing. Every convenient prebuilt static ffmpeg (BtbN, osxexperts,
#     evermeet, martin-riedl) bundles libx264/libx265 and is therefore GPL.
#     Colloquium ships signed binaries to users, so we keep the whole thing
#     LGPL-2.1 by building with --disable-autodetect and enabling nothing but
#     OS-provided frameworks.
#   * Size. Those same builds statically link aom, svt-av1, dav1d, libvpx and
#     friends: BtbN's LGPL ffmpeg.exe alone is 113 MB, so ffmpeg+ffprobe would
#     add ~226 MB to a 17.5 MB installer. With no external libraries each
#     binary is ~13 MB, because every codec we actually need is native to
#     libavcodec.
#
# What we deliberately do NOT enable:
#
#   * Any TLS backend. ffmpeg never talks to the internet — Rust fetches the
#     remote source and re-serves it over plain http on 127.0.0.1 (see
#     media.rs), so ffmpeg only ever needs the http/tcp/file protocols. This is
#     what removes the single most fragile part of a hand-rolled build.
#   * libx264/libx265. H.264 encoding uses the platform encoder instead:
#     h264_videotoolbox on macOS, h264_mf (Media Foundation) on Windows. Both
#     are OS frameworks, so they cost nothing in size and nothing in licensing.
#
# Usage:  scripts/build-ffmpeg.sh <output-dir> [target-triple]
# The target triple only labels the output filenames; this script always builds
# for the host architecture. Universal macOS binaries are produced by lipo'ing
# two native builds together in .github/workflows/build-ffmpeg.yml.

set -euo pipefail

FFMPEG_REF="${FFMPEG_REF:-n8.1.2}"
# The *commit* the tag points at, not the annotated tag object's own sha. Get it
# with the ^{} dereference, or this assertion will fail confusingly:
#   git ls-remote --tags https://github.com/FFmpeg/FFmpeg.git 'refs/tags/n8.1.2^{}'
FFMPEG_COMMIT="${FFMPEG_COMMIT:-38b88335f99e76ed89ff3c93f877fdefce736c13}"
FFMPEG_REPO="${FFMPEG_REPO:-https://github.com/FFmpeg/FFmpeg.git}"

OUT_DIR="${1:?usage: build-ffmpeg.sh <output-dir> [target-triple]}"
TRIPLE="${2:-}"

mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"

case "$(uname -s)" in
  Darwin)            HOST_OS=macos ;;
  MINGW*|MSYS*|CYGWIN*) HOST_OS=windows ;;
  Linux)             HOST_OS=linux ;;
  *) echo "build-ffmpeg.sh: unsupported host $(uname -s)" >&2; exit 1 ;;
esac

if [ -z "$TRIPLE" ]; then
  case "$HOST_OS" in
    macos)   TRIPLE="$( [ "$(uname -m)" = "arm64" ] && echo aarch64-apple-darwin || echo x86_64-apple-darwin )" ;;
    windows) TRIPLE="x86_64-pc-windows-msvc" ;;
    linux)   TRIPLE="x86_64-unknown-linux-gnu" ;;
  esac
fi

EXE=""
[ "$HOST_OS" = windows ] && EXE=".exe"

WORK="${FFMPEG_BUILD_DIR:-${TMPDIR:-/tmp}/colloquium-ffmpeg-build}"
SRC="$WORK/FFmpeg"
mkdir -p "$WORK"

echo "==> ffmpeg $FFMPEG_REF ($FFMPEG_COMMIT) for $TRIPLE"

# Shallow-fetch the pinned tag, then assert the commit. Git's own integrity
# check is the pin here, so there is no tarball checksum to keep in sync.
if [ ! -d "$SRC/.git" ]; then
  git init -q "$SRC"
  git -C "$SRC" remote add origin "$FFMPEG_REPO"
fi
git -C "$SRC" fetch -q --depth 1 origin "refs/tags/$FFMPEG_REF"
git -C "$SRC" checkout -q FETCH_HEAD
actual="$(git -C "$SRC" rev-parse HEAD)"
if [ "$actual" != "$FFMPEG_COMMIT" ]; then
  echo "build-ffmpeg.sh: $FFMPEG_REF resolved to $actual, expected $FFMPEG_COMMIT" >&2
  echo "  A tag was moved or repointed. Verify before updating scripts/ffmpeg-manifest.json." >&2
  exit 1
fi

# --disable-autodetect is the load-bearing flag: without it configure links
# against whatever happens to be installed on the build machine (Homebrew's
# x264, for instance), which would silently make the output GPL and unreproducible.
CONFIGURE_ARGS=(
  --prefix="$WORK/install"
  --disable-autodetect
  --disable-doc
  --disable-ffplay
  --disable-shared
  --enable-static
  --disable-debug
  --enable-protocol=file,pipe,http,tcp
)

case "$HOST_OS" in
  macos)
    # OS frameworks: hardware H.264/HEVC encode + decode, and the system audio
    # codecs. No external libraries, no license implications.
    CONFIGURE_ARGS+=(--enable-videotoolbox --enable-audiotoolbox)
    ;;
  windows)
    # h264_mf is the Media Foundation encoder: present on every Windows install,
    # GPU-accelerated when the driver supports it, and LGPL-clean. d3d11va/dxva2
    # give hardware *decode*.
    CONFIGURE_ARGS+=(--enable-mediafoundation --enable-d3d11va --enable-dxva2)
    CONFIGURE_ARGS+=(--extra-ldexeflags='-static -static-libgcc -static-libstdc++')
    ;;
esac

cd "$SRC"
# A stale config from a previous run with different flags is a classic source of
# confusing build failures.
make distclean >/dev/null 2>&1 || true
./configure "${CONFIGURE_ARGS[@]}"

# Fail loudly rather than shipping a GPL binary by accident.
if grep -qE '^#define CONFIG_GPL 1$' config.h; then
  echo "build-ffmpeg.sh: refusing to continue — configure produced a GPL build" >&2
  exit 1
fi

make -j"$( (getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4) )"

for tool in ffmpeg ffprobe; do
  dest="$OUT_DIR/$tool-$TRIPLE$EXE"
  cp "$SRC/$tool$EXE" "$dest"
  chmod 755 "$dest"
  # `lipo` and `strip` both invalidate a signature, so sign last. On Apple
  # Silicon an unsigned Mach-O is killed by the kernel on exec, so this is not
  # optional — it is the difference between working and SIGKILL.
  if [ "$HOST_OS" = macos ]; then
    strip -S -x "$dest" 2>/dev/null || true
    codesign --force --sign - --timestamp=none "$dest"
  else
    strip "$dest" 2>/dev/null || true
  fi
  printf '    %-34s %s\n' "$(basename "$dest")" "$(du -h "$dest" | cut -f1)"
done

echo "==> done: $OUT_DIR"
