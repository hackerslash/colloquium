fn main() {
    #[cfg(target_os = "macos")]
    {
        for path in ["/opt/homebrew/lib", "/usr/local/lib"] {
            if std::path::Path::new(path).exists() {
                println!("cargo:rustc-link-search=native={path}");
            }
        }
    }
    tauri_build::build()
}
