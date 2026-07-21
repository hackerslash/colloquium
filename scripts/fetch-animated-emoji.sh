#!/usr/bin/env bash
# One-time/maintainer tool: fetches a curated subset of Microsoft's MIT-licensed
# Fluent Emoji Animated set (github.com/microsoft/fluentui-emoji-animated),
# downscales, and re-encodes each to animated WebP for bundling into the app.
#
# Not run as part of `pnpm build` — run manually when adding/updating the
# curated set, then commit the resulting .webp files under
# src/assets/emoji-animated/ like any other asset. Requires `curl` and
# `ffmpeg` on PATH.
#
# Source assets are ~1.6MB APNGs at 256x256 behind git-lfs; the LFS-resolved
# download URL is media.githubusercontent.com/media/... (raw.githubusercontent.com
# and jsDelivr's gh path both serve the unresolved LFS pointer file, not the
# image). Output is 128x128 animated WebP, ~30-120KB each.
set -euo pipefail

OUT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/src/assets/emoji-animated"
mkdir -p "$OUT_DIR"

# id:Folder Name (folder name as it appears in the upstream repo's assets/ dir)
EMOJI_LIST=(
  "tada:Party popper"
  "thumbs-up:Thumbs up"
  "thumbs-down:Thumbs down"
  "clap:Clapping hands"
  "heart:Red heart"
  "heart-sparkle:Sparkling heart"
  "two-hearts:Two hearts"
  "heart-fire:Heart on fire"
  "heart-beat:Beating heart"
  "heart-grow:Growing heart"
  "joy:Face with tears of joy"
  "sob:Loudly crying face"
  "cry:Crying face"
  "thinking:Thinking face"
  "fire:Fire"
  "hundred:Hundred points"
  "eyes:Eyes"
  "rocket:Rocket"
  "star-struck:Star-struck"
  "wow:Face with open mouth"
  "pray:Folded hands"
  "muscle:Flexed biceps"
  "ok-hand:Ok hand"
  "wave:Waving hand"
  "grin:Grinning face"
  "wink:Winking face"
  "heart-eyes:Smiling face with heart-eyes"
  "blow-kiss:Face blowing a kiss"
  "astonished:Astonished face"
  "mind-blown:Exploding head"
  "clown:Clown face"
  "skull:Skull"
  "ghost:Ghost"
  "sun:Sun"
  "rainbow:Rainbow"
  "cake:Birthday cake"
  "nerd:Nerd face"
  "tongue:Face with tongue"
  "angry:Angry face"
  "pleading:Pleading face"
  "sunglasses:Smiling face with sunglasses"
  "sleepy:Zzz"
  "see-no-evil:See-no-evil monkey"
  "hear-no-evil:Hear-no-evil monkey"
  "speak-no-evil:Speak-no-evil monkey"
  "dog:Dog face"
  "cat:Cat face"
  "money-face:Money-mouth face"
  "monocle:Face with monocle"
  "robot:Robot"
  "hug:Hugging face"
  "kiss:Kissing face with closed eyes"
  "party-face:Partying face"
  "smirk:Smirking face"
  "neutral:Neutral face"
  "frown:Frowning face"
  "weary:Weary face"
  "hushed:Hushed face"
  "confounded:Confounded face"
  "scream:Face screaming in fear"
  "vomit:Face vomiting"
  "hot:Hot face"
  "cold:Cold face"
  "zany:Zany face"
  "shush:Shushing face"
  "gasp:Face with hand over mouth"
  "sneeze:Sneezing face"
  "persevere:Persevering face"
  "worried:Worried face"
  "sleep:Sleeping face"
)

BASE="https://media.githubusercontent.com/media/microsoft/fluentui-emoji-animated/main/assets"

fail=0
for entry in "${EMOJI_LIST[@]}"; do
  id="${entry%%:*}"
  folder="${entry#*:}"
  slug="$(echo "$folder" | tr '[:upper:]' '[:lower:]' | tr ' ' '_')"
  folder_enc="$(echo "$folder" | sed 's/ /%20/g')"
  # Most emoji: Folder/animated/<slug>_animated.png. Human/hand gesture emoji
  # instead have per-skin-tone subfolders (Default/Light/Medium/.../Dark)
  # with Folder/Default/animated/<slug>_animated_default.png — try the plain
  # path first, then fall back to the Default skin-tone variant.
  url="${BASE}/${folder_enc}/animated/${slug}_animated.png"
  url_fallback="${BASE}/${folder_enc}/Default/animated/${slug}_animated_default.png"
  tmp_png="$(mktemp --suffix=.png)"
  out="${OUT_DIR}/${id}.webp"

  if [ -f "$out" ]; then
    echo "Skipping '${folder}' -> ${id}.webp (already exists)"
    rm -f "$tmp_png"
    continue
  fi

  echo "Fetching '${folder}' -> ${id}.webp"
  if ! curl -fsSL "$url" -o "$tmp_png" 2>/dev/null && ! curl -fsSL "$url_fallback" -o "$tmp_png"; then
    echo "  FAILED to download: $url (and fallback $url_fallback)" >&2
    fail=1
    rm -f "$tmp_png"
    continue
  fi

  if ! ffmpeg -y -loglevel error -i "$tmp_png" -vf scale=128:128 -loop 0 -q:v 75 "$out"; then
    echo "  FAILED to re-encode: $id" >&2
    fail=1
  fi
  rm -f "$tmp_png"
done

if [ "$fail" -ne 0 ]; then
  echo "One or more emoji failed to fetch/encode — check output above." >&2
  exit 1
fi

echo "Done. $(ls "$OUT_DIR"/*.webp | wc -l) animated emoji in $OUT_DIR"
