# Third-party software

## FFmpeg

Colloquium bundles the `ffmpeg` and `ffprobe` executables as sidecars. They are
used by the watch-party feature to inspect a video source and to remux or
transcode it into HLS for playback; they are invoked as child processes and
nothing in Colloquium links against them.

**License: GNU Lesser General Public License, version 2.1 or later (LGPL-2.1+).**

The build is deliberately configured to stay LGPL. It contains no GPL
components — in particular no `libx264`, no `libx265`, and no `--enable-gpl`.
`scripts/build-ffmpeg.sh` aborts the build if `configure` leaves `CONFIG_GPL`
set, so a GPL binary cannot be produced by accident.

- Upstream: <https://ffmpeg.org/>
- Source: <https://github.com/FFmpeg/FFmpeg>
- Version: `n8.1.2`, commit `38b88335f99e76ed89ff3c93f877fdefce736c13`
- License text: <https://www.ffmpeg.org/legal.html>

### Corresponding source

The binaries are built from unmodified upstream FFmpeg at the commit above. No
patches are applied. The complete, scripted build — the pinned commit, the
`configure` invocation, the toolchain, and the license assertions — is in this
repository:

- `scripts/build-ffmpeg.sh` — the build itself
- `scripts/ffmpeg-manifest.json` — the pinned commit and artifact checksums
- `.github/workflows/build-ffmpeg.yml` — the workflow that produces the
  published binaries on macOS (arm64 + x86_64, combined with `lipo`) and Windows

To reproduce a bundled binary, check out the pinned FFmpeg commit and run
`scripts/build-ffmpeg.sh <output-dir> <target-triple>`.

### Configure options

Common to all platforms:

```
--prefix=<workdir>/install
--disable-autodetect
--disable-doc
--disable-ffplay
--disable-shared
--enable-static
--disable-debug
--enable-protocol=file,pipe,http,tcp
```

Additionally on macOS:

```
--enable-videotoolbox --enable-audiotoolbox
```

Additionally on Windows:

```
--enable-mediafoundation --enable-d3d11va --enable-dxva2
```

`--disable-autodetect` is what keeps the build reproducible and LGPL: without
it, `configure` links against whatever happens to be installed on the build
machine — Homebrew's `libx264`, for instance — which would silently make the
result GPL. The platform additions are operating-system frameworks
(VideoToolbox, AudioToolbox, Media Foundation, D3D11VA/DXVA2) for hardware
encode and decode; they are not external libraries and carry no license
implications.

`--enable-protocol` deliberately omits `https`/`tls`. Colloquium proxies remote
sources over plain HTTP on the loopback interface instead, so the bundled
FFmpeg has no network TLS stack and cannot reach the internet on its own.

### Relinking

LGPL-2.1 §6 allows a user to modify the library and relink it. Because these are
separate executables rather than linked libraries, that requirement is satisfied
directly: build your own `ffmpeg` and `ffprobe` from the source above and
replace the bundled files.

- **macOS** — `Colloquium.app/Contents/MacOS/ffmpeg` and `.../ffprobe`. Replacing
  a file inside the bundle invalidates the app's code signature; re-sign with
  `codesign --force --deep --sign - Colloquium.app`.
- **Windows** — `ffmpeg.exe` and `ffprobe.exe` beside `Colloquium.exe` in the
  installation directory.

## hls.js

Bundled into the application JavaScript and used to play the HLS output of the
remux pipeline through a standard `<video>` element.

- Upstream: <https://github.com/video-dev/hls.js>
- License: Apache License 2.0
