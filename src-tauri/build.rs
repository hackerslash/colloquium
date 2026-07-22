use std::path::{Path, PathBuf};
use std::process::Command;

// Pinned libmpv build. The committed Windows import libs in
// vendor/mpv/windows-x86_64 are generated from this exact archive, so the
// fetched runtime DLL always matches them. Bump both together.
#[cfg(target_os = "windows")]
const MPV_WIN_URL: &str = "https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/20260610/mpv-dev-x86_64-20260610-git-304426c.7z";

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    provision_mpv();
    tauri_build::build()
}

#[cfg(target_os = "macos")]
fn provision_mpv() {
    if let Some(dir) = macos_libmpv_dir() {
        println!("cargo:rustc-link-search=native={}", dir.display());
        return;
    }
    println!("cargo:warning=libmpv not found; attempting `brew install mpv`...");
    println!("cargo:rerun-if-env-changed=HAVEN_SKIP_MPV_AUTOINSTALL");
    if std::env::var_os("HAVEN_SKIP_MPV_AUTOINSTALL").is_none() && which("brew").is_some() {
        let ok = Command::new("brew")
            .args(["install", "mpv"])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if ok {
            if let Some(dir) = macos_libmpv_dir() {
                println!("cargo:rustc-link-search=native={}", dir.display());
                return;
            }
        }
    }
    panic!(
        "libmpv is required but was not found and could not be installed automatically.\n\
         Install it with:  brew install mpv\n\
         (set HAVEN_SKIP_MPV_AUTOINSTALL=1 to skip the auto-install attempt.)"
    );
}

#[cfg(target_os = "macos")]
fn macos_libmpv_dir() -> Option<PathBuf> {
    let mut candidates = vec![
        PathBuf::from("/opt/homebrew/lib"),
        PathBuf::from("/usr/local/lib"),
    ];
    if let Some(out) = Command::new("brew").args(["--prefix", "mpv"]).output().ok() {
        if out.status.success() {
            let prefix = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !prefix.is_empty() {
                candidates.insert(0, Path::new(&prefix).join("lib"));
            }
        }
    }
    candidates.into_iter().find(|d| {
        d.join("libmpv.dylib").exists() || d.join("libmpv.2.dylib").exists()
    })
}

#[cfg(target_os = "windows")]
fn provision_mpv() {
    if !cfg!(target_arch = "x86_64") {
        panic!(
            "Vendored libmpv is only provided for x86_64 Windows. \
             Add import libs under src-tauri/vendor/mpv/windows-<arch> for your target."
        );
    }
    let manifest = PathBuf::from(env("CARGO_MANIFEST_DIR"));
    let vendor = manifest.join("vendor/mpv/windows-x86_64");
    println!("cargo:rustc-link-search=native={}", vendor.display());

    // The 117 MB runtime DLL is not committed. Cache it in the vendor dir and
    // copy it next to the executable so `tauri dev` / `cargo run` can load it.
    let dll_cache = vendor.join("libmpv-2.dll");
    if !dll_cache.exists() {
        fetch_windows_dll(&dll_cache);
    }
    let target_dir = PathBuf::from(env("OUT_DIR"))
        .ancestors()
        .nth(3)
        .expect("OUT_DIR has expected depth")
        .to_path_buf();
    let dest = target_dir.join("libmpv-2.dll");
    if let Err(e) = std::fs::copy(&dll_cache, &dest) {
        println!("cargo:warning=failed to copy libmpv-2.dll next to the executable: {e}");
    }
    println!("cargo:rerun-if-changed={}", dll_cache.display());
}

#[cfg(target_os = "windows")]
fn fetch_windows_dll(dll_cache: &Path) {
    let dir = dll_cache.parent().unwrap();
    let archive = dir.join("mpv-dev.7z");
    println!("cargo:warning=downloading libmpv runtime DLL (~30 MB) from {MPV_WIN_URL}");

    let downloaded = Command::new("curl")
        .args(["-fsSL", "--max-time", "300", "-o"])
        .arg(&archive)
        .arg(MPV_WIN_URL)
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
        || Command::new("powershell")
            .args(["-NoProfile", "-Command"])
            .arg(format!(
                "Invoke-WebRequest -Uri '{MPV_WIN_URL}' -OutFile '{}'",
                archive.display()
            ))
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
    if !downloaded {
        panic!("failed to download libmpv from {MPV_WIN_URL}");
    }

    // Windows' bundled tar.exe (libarchive) reads 7z; extract just the DLL.
    let extracted = Command::new("tar")
        .arg("-xf")
        .arg(&archive)
        .arg("-C")
        .arg(dir)
        .arg("libmpv-2.dll")
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    let _ = std::fs::remove_file(&archive);
    if !extracted || !dll_cache.exists() {
        panic!(
            "failed to extract libmpv-2.dll from {}.\n\
             Extract it manually into that folder (e.g. with 7-Zip).",
            archive.display()
        );
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn provision_mpv() {
    // Linux and others: rely on the system-provided libmpv (libmpv-dev /
    // libmpv2). It normally sits on the default linker search path.
    let found = Command::new("pkg-config")
        .args(["--exists", "mpv"])
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if found {
        if let Some(out) = Command::new("pkg-config")
            .args(["--variable=libdir", "mpv"])
            .output()
            .ok()
        {
            let dir = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !dir.is_empty() {
                println!("cargo:rustc-link-search=native={dir}");
            }
        }
    } else {
        println!(
            "cargo:warning=libmpv development files not found. Install your \
             distro's libmpv package (e.g. `apt install libmpv-dev`, \
             `dnf install mpv-libs-devel`, `pacman -S mpv`)."
        );
    }
}

#[allow(dead_code)]
fn env(key: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| panic!("{key} not set"))
}

#[allow(dead_code)]
fn which(bin: &str) -> Option<PathBuf> {
    Command::new("sh")
        .arg("-c")
        .arg(format!("command -v {bin}"))
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| PathBuf::from(String::from_utf8_lossy(&o.stdout).trim()))
}
