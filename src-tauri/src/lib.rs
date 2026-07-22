mod db;
mod identity;
mod keychain;
mod sysaudio;
mod tray;
mod watchparty;

use std::sync::Mutex;
use tauri::{Manager, WindowEvent};
use tauri_plugin_window_state::StateFlags;

/// Mirrors the frontend's `closeToTray` setting so the window-close handler
/// (which runs on the Rust side, ahead of any JS listener) knows whether to
/// hide to tray or let the app quit normally. Defaults to the setting's own
/// default so a fresh app matches current behavior before the frontend loads
/// the persisted value and syncs it via `set_close_to_tray`.
struct CloseToTray(Mutex<bool>);

/// Whether the tray icon actually came up (see `setup` below) — some Linux
/// desktops have no tray host at all, in which case hiding to "tray" would
/// strand the user with no way to reopen the window.
struct TrayAvailable(bool);

#[tauri::command]
fn set_close_to_tray(state: tauri::State<CloseToTray>, enabled: bool) {
    *state.0.lock().unwrap() = enabled;
}

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
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        // Migrations run in our own keyed pool inside `db::init` (below), not
        // via the plugin — see setup. The plugin is registered bare so its
        // execute/select commands resolve against the injected SQLCipher pool.
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                // Manage size/position/maximized, but not visibility — the
                // window starts hidden and is shown by the frontend once the
                // first meaningful frame is ready, to avoid a startup flash.
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                .build(),
        )
        .manage(CloseToTray(Mutex::new(true)))
        .setup(|app| {
            // Open (and, on first run after this ships, encrypt) the local DB
            // and inject the keyed pool BEFORE anything else — IPC only starts
            // after setup returns, so no query can race this.
            tauri::async_runtime::block_on(db::init(app.handle()))?;

            // Best-effort: some Linux desktop environments have no tray host
            // (no StatusNotifierWatcher), which would otherwise take the
            // whole app down at launch. Run without a tray icon instead.
            let tray_ok = match tray::build(app) {
                Ok(()) => true,
                Err(err) => {
                    eprintln!("failed to create tray icon: {err}");
                    false
                }
            };
            app.manage(TrayAvailable(tray_ok));
            Ok(())
        })
        .on_window_event(|window, event| {
            // Close-to-tray: hide the window instead of quitting so calls and
            // the P2P connection survive. Quit is available from the tray menu.
            // Skipped when the user has turned the setting off, in which case
            // this falls through to Tauri's default close behavior.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    let close_to_tray = *window.state::<CloseToTray>().0.lock().unwrap();
                    let tray_available = window.state::<TrayAvailable>().0;
                    if close_to_tray && tray_available {
                        api.prevent_close();
                        let _ = window.hide();
                    }
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
            sysaudio::sysaudio_start,
            sysaudio::sysaudio_stop,
            watchparty::wp_player_available,
            watchparty::wp_player_init,
            watchparty::wp_player_load,
            watchparty::wp_player_set_pause,
            watchparty::wp_player_seek,
            watchparty::wp_player_set_speed,
            watchparty::wp_player_set_audio_track,
            watchparty::wp_player_set_sub_track,
            watchparty::wp_player_set_sub_delay,
            watchparty::wp_player_add_subtitle,
            watchparty::wp_player_get_tracks,
            watchparty::wp_player_now,
            watchparty::wp_player_set_rect,
            watchparty::wp_player_teardown,
            set_close_to_tray,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
