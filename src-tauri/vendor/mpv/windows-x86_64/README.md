# Vendored libmpv import libraries (Windows x86_64)

These are the small (~50 KB) import libraries the linker needs. The 117 MB
runtime `libmpv-2.dll` is **not** committed — `build.rs` downloads it on first
build into a git-ignored cache and copies it next to the executable.

- `mpv.lib` — COFF import lib for the MSVC toolchain (Rust default on Windows).
- `libmpv.dll.a` — import lib for the GNU (`x86_64-pc-windows-gnu`) toolchain.
- `mpv.def` — export list used to regenerate `mpv.lib`.

## Provenance (keep in sync with `MPV_WIN_URL` in `build.rs`)

Pinned release: shinchiro/mpv-winbuild-cmake tag `20260610` (git `304426c`).
Both the import libs here and the DLL `build.rs` fetches come from the same
`mpv-dev-x86_64-20260610-git-304426c.7z`, so they always match.

## Regenerating (only when bumping the pinned version)

Requires LLVM (`brew install llvm`) and 7z; runs on any OS:

```sh
7z e mpv-dev-x86_64-<ver>.7z libmpv-2.dll libmpv.dll.a
{ echo "LIBRARY libmpv-2.dll"; echo "EXPORTS"; \
  llvm-readobj --coff-exports libmpv-2.dll | awk '/Name:/{print $2}' | sort -u; } > mpv.def
llvm-dlltool -m i386:x86-64 -D libmpv-2.dll -d mpv.def -l mpv.lib
```
