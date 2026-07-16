mod db;
mod identity;
mod keychain;
mod tray;

use tauri::{Manager, WindowEvent};
use tauri_plugin_window_state::StateFlags;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
                let _ = window.unminimize();
            }
        }));
    }

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations(db::DB_URL, db::migrations())
                .build(),
        )
        .plugin(
            tauri_plugin_window_state::Builder::default()
                // Manage size/position/maximized, but not visibility — the
                // window starts hidden and is shown by the frontend once the
                // first meaningful frame is ready, to avoid a startup flash.
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                .build(),
        )
        .setup(|app| {
            tray::build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Close-to-tray: hide the window instead of quitting so calls and
            // the P2P connection survive. Quit is available from the tray menu.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            identity::identity_has_keypair,
            identity::identity_generate_keypair,
            identity::identity_get_public_key,
            identity::identity_sign,
            identity::identity_verify,
            identity::identity_delete_keypair,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
