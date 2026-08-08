mod db;
mod identity;
mod keychain;
mod media;
mod sysaudio;
mod tray;

use std::sync::Mutex;
use std::time::Duration;
use tauri::{Emitter, Manager, WindowEvent};
use tauri_plugin_window_state::StateFlags;

/// Period of the `net-tick` event that drives peer discovery and heartbeats.
/// Must match what the frontend's liveness timeouts assume.
const NET_TICK_MS: u64 = 2_000;

/// Launch flag we register with the autostart plugin, so a login-triggered
/// start goes straight to the tray instead of popping the window open.
const HIDDEN_ARG: &str = "--hidden";

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

/// Whether this process was launched by the autostart entry (i.e. at login)
/// rather than by the user. Read once from argv, since the frontend decides
/// whether to reveal the window and can't see the process arguments itself.
struct StartHidden(bool);

#[tauri::command]
fn set_close_to_tray(state: tauri::State<CloseToTray>, enabled: bool) {
    *state.0.lock().unwrap() = enabled;
}

/// Only honour the hidden launch if there's a tray to restore from — same
/// reasoning as close-to-tray, since a hidden window with no tray icon leaves
/// the user no way to reach the app at all.
#[tauri::command]
fn should_start_hidden(
    hidden: tauri::State<StartHidden>,
    tray: tauri::State<TrayAvailable>,
) -> bool {
    hidden.0 && tray.0
}

/// Grant the webview camera/mic access up front on Windows.
///
/// WKWebView's delegate auto-grants capture (wry does this for us), so on macOS
/// the only prompt is the OS one, which the system remembers forever. WebView2
/// has no such delegate by default: it shows its OWN prompt, and it refuses to
/// persist the answer for the `http://tauri.localhost` origin Tauri serves from
/// — so every launch asks again. Answering it here makes Windows behave like
/// macOS, leaving Settings > Privacy > Camera/Microphone as the real gate.
#[cfg(target_os = "windows")]
fn grant_media_capture(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_CAMERA,
        COREWEBVIEW2_PERMISSION_KIND_MICROPHONE, COREWEBVIEW2_PERMISSION_STATE_ALLOW,
    };
    use webview2_com::PermissionRequestedEventHandler;

    window.with_webview(|webview| unsafe {
        let Ok(core) = webview.controller().CoreWebView2() else {
            return;
        };
        let mut token = 0i64;
        let _ = core.add_PermissionRequested(
            &PermissionRequestedEventHandler::create(Box::new(|_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                args.PermissionKind(&mut kind)?;
                if kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE
                    || kind == COREWEBVIEW2_PERMISSION_KIND_CAMERA
                {
                    // Setting a state also suppresses WebView2's default prompt.
                    args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
                }
                Ok(())
            })),
            &mut token,
        );
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
                let _ = window.unminimize();
            }
        }));
    }

    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    {
        builder = builder.plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![HIDDEN_ARG]),
        ));
    }

    builder
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        // Saving attachments and transcripts: `dialog.save` picks the path and
        // adds it to the fs scope, then `fs.writeFile` writes there. The fs
        // scope stays empty in capabilities on purpose — only paths the user
        // actively picked in a native dialog are ever writable.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
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
        .manage(StartHidden(std::env::args().any(|a| a == HIDDEN_ARG)))
        .manage(media::MediaState::default())
        .setup(|app| {
            // Open (and, on first run after this ships, encrypt) the local DB
            // and inject the keyed pool BEFORE anything else — IPC only starts
            // after setup returns, so no query can race this.
            tauri::async_runtime::block_on(db::init(app.handle()))?;

            // Before the frontend can reach getUserMedia — it doesn't run until
            // identity has loaded, but the handler has to be attached first.
            #[cfg(target_os = "windows")]
            if let Some(window) = app.get_webview_window("main") {
                if let Err(err) = grant_media_capture(&window) {
                    eprintln!("failed to grant webview media capture: {err}");
                }
            }

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

            // Drop any watch-party remux cache a previous run left behind — a
            // crash can strand multi-gigabyte segment directories.
            media::cleanup_stale(app.handle());

            // Peer discovery and heartbeats run off this tick rather than a
            // webview `setInterval`, because a hidden window gets its timers
            // throttled toward ~1/min — which is slower than the 10s liveness
            // timeout, so live peers would be reaped and re-dialed forever.
            // The OS timer keeps its period regardless of window visibility.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut ticker = tokio::time::interval(Duration::from_millis(NET_TICK_MS));
                loop {
                    ticker.tick().await;
                    if handle.emit("net-tick", ()).is_err() {
                        break;
                    }
                }
            });
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
            media::media_open,
            media::media_probe,
            media::media_open_window,
            media::media_extract_subtitle,
            media::media_extract_progress,
            media::media_close,
            set_close_to_tray,
            should_start_hidden,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        // Built rather than `run`, only so ffmpeg children are killed on the way
        // out. A surviving ffmpeg would keep downloading and writing segments
        // after the app is gone.
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                media::shutdown(app);
            }
        });
}
