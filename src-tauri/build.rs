fn main() {
    if std::env::var("PROFILE").as_deref() == Ok("debug") && std::env::var("TAURI_CONFIG").is_err() {
        unsafe {
            std::env::set_var(
                "TAURI_CONFIG",
                r#"{"identifier":"colloquiumapp.dev","productName":"Colloquium Dev","app":{"windows":[{"title":"Colloquium — Dev","width":1280,"height":800,"minWidth":900,"minHeight":600,"visible":false,"dragDropEnabled":false}]}}"#,
            );
        }
    }
    tauri_build::build()
}
