use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use libmpv2::Mpv;
use serde::Serialize;
use tauri::ipc::Channel;

static START: OnceLock<Instant> = OnceLock::new();

fn elapsed_ms() -> f64 {
    START.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
}

#[derive(Serialize, Clone)]
pub struct TrackInfo {
    id: i64,
    #[serde(rename = "type")]
    track_type: String,
    title: Option<String>,
    lang: Option<String>,
    codec: Option<String>,
    selected: bool,
    #[serde(rename = "isDefault")]
    is_default: bool,
}

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum WpEvent {
    Time { pos: f64, ts_ms: f64 },
    Duration { duration: f64 },
    Pause { paused: bool },
    Buffering { paused_for_cache: bool, cached_sec: f64, ready: bool },
    Tracks { tracks: Vec<TrackInfo> },
    Eof,
    Error { message: String },
}

struct Player {
    mpv: Arc<Mpv>,
    running: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
    #[cfg(target_os = "macos")]
    window: tauri::WebviewWindow,
    #[cfg(target_os = "macos")]
    host_view: usize,
}

static STATE: Mutex<Option<Player>> = Mutex::new(None);
static SETUP: Mutex<()> = Mutex::new(());

fn with_mpv<T>(f: impl FnOnce(&Mpv) -> T) -> Result<T, String> {
    let guard = STATE.lock().map_err(|_| "player poisoned".to_string())?;
    let player = guard.as_ref().ok_or("player not initialized".to_string())?;
    Ok(f(&player.mpv))
}

#[tauri::command]
pub fn wp_player_available() -> bool {
    Mpv::with_initializer(|_| Ok(())).is_ok()
}

#[tauri::command]
pub async fn wp_player_init(
    window: tauri::WebviewWindow,
    channel: Channel<WpEvent>,
) -> Result<(), String> {
    START.get_or_init(Instant::now);
    tauri::async_runtime::spawn_blocking(move || init_blocking(window, channel))
        .await
        .map_err(|e| e.to_string())
        .and_then(|inner| inner)
}

fn init_blocking(window: tauri::WebviewWindow, channel: Channel<WpEvent>) -> Result<(), String> {
    let _setup = SETUP.lock().unwrap_or_else(|e| e.into_inner());
    teardown_inner();

    #[cfg(target_os = "macos")]
    let host_view = macos::embed(&window)?;

    let mpv = Mpv::with_initializer(|init| {
        let _ = init.set_property("config", false);
        let _ = init.set_property("terminal", false);
        let _ = init.set_property("osc", false);
        let _ = init.set_property("input-default-bindings", false);
        let _ = init.set_property("input-vo-keyboard", false);
        let _ = init.set_property("hr-seek", "yes");
        let _ = init.set_property("keep-open", "yes");
        let _ = init.set_property("hwdec", "auto-safe");
        let _ = init.set_property("cache", "yes");
        #[cfg(target_os = "macos")]
        let _ = init.set_property("wid", host_view as i64);
        Ok(())
    })
    .map_err(|e| format!("mpv init failed: {e}"))?;

    let mpv = Arc::new(mpv);
    let running = Arc::new(AtomicBool::new(true));
    let poll_mpv = mpv.clone();
    let poll_running = running.clone();
    let join = std::thread::spawn(move || poll_loop(poll_mpv, poll_running, channel));

    let mut guard = STATE.lock().unwrap_or_else(|e| e.into_inner());
    *guard = Some(Player {
        mpv,
        running,
        join: Some(join),
        #[cfg(target_os = "macos")]
        window,
        #[cfg(target_os = "macos")]
        host_view,
    });
    #[cfg(not(target_os = "macos"))]
    let _ = window;
    Ok(())
}

fn get_f64(mpv: &Mpv, name: &str) -> Option<f64> {
    mpv.get_property::<f64>(name).ok()
}

fn get_bool(mpv: &Mpv, name: &str) -> Option<bool> {
    mpv.get_property::<bool>(name).ok()
}

fn get_string(mpv: &Mpv, name: &str) -> Option<String> {
    mpv.get_property::<String>(name).ok().filter(|s| !s.is_empty())
}

fn read_tracks(mpv: &Mpv) -> Vec<TrackInfo> {
    let count = mpv.get_property::<i64>("track-list/count").unwrap_or(0);
    let mut out = Vec::new();
    for i in 0..count {
        let id = mpv.get_property::<i64>(&format!("track-list/{i}/id")).unwrap_or(0);
        let track_type = get_string(mpv, &format!("track-list/{i}/type")).unwrap_or_default();
        out.push(TrackInfo {
            id,
            track_type,
            title: get_string(mpv, &format!("track-list/{i}/title")),
            lang: get_string(mpv, &format!("track-list/{i}/lang")),
            codec: get_string(mpv, &format!("track-list/{i}/codec")),
            selected: get_bool(mpv, &format!("track-list/{i}/selected")).unwrap_or(false),
            is_default: get_bool(mpv, &format!("track-list/{i}/default")).unwrap_or(false),
        });
    }
    out
}

fn tracks_fingerprint(tracks: &[TrackInfo]) -> String {
    tracks
        .iter()
        .map(|t| format!("{}:{}:{}", t.id, t.track_type, t.selected))
        .collect::<Vec<_>>()
        .join("|")
}

fn poll_loop(mpv: Arc<Mpv>, running: Arc<AtomicBool>, channel: Channel<WpEvent>) {
    let mut last_duration = -1.0_f64;
    let mut last_paused: Option<bool> = None;
    let mut last_cache: Option<bool> = None;
    let mut last_eof = false;
    let mut last_tracks = String::new();

    while running.load(Ordering::Relaxed) {
        if let Some(pos) = get_f64(&mpv, "time-pos") {
            let _ = channel.send(WpEvent::Time { pos, ts_ms: elapsed_ms() });
        }
        if let Some(d) = get_f64(&mpv, "duration") {
            if (d - last_duration).abs() > 0.01 {
                last_duration = d;
                let _ = channel.send(WpEvent::Duration { duration: d });
            }
        }
        if let Some(p) = get_bool(&mpv, "pause") {
            if last_paused != Some(p) {
                last_paused = Some(p);
                let _ = channel.send(WpEvent::Pause { paused: p });
            }
        }
        let pfc = get_bool(&mpv, "paused-for-cache").unwrap_or(false);
        let cached = get_f64(&mpv, "demuxer-cache-duration").unwrap_or(0.0);
        if last_cache != Some(pfc) {
            last_cache = Some(pfc);
            let _ = channel.send(WpEvent::Buffering {
                paused_for_cache: pfc,
                cached_sec: cached,
                ready: !pfc && cached >= 0.5,
            });
        }
        let eof = get_bool(&mpv, "eof-reached").unwrap_or(false);
        if eof && !last_eof {
            let _ = channel.send(WpEvent::Eof);
        }
        last_eof = eof;

        let tracks = read_tracks(&mpv);
        let fp = tracks_fingerprint(&tracks);
        if fp != last_tracks {
            last_tracks = fp;
            let _ = channel.send(WpEvent::Tracks { tracks });
        }

        std::thread::sleep(Duration::from_millis(120));
    }
}

#[tauri::command]
pub async fn wp_player_load(url: String) -> Result<(), String> {
    with_mpv(move |mpv| mpv.command("loadfile", &[&url, "replace"]).map_err(|e| e.to_string()))?
}

#[tauri::command]
pub fn wp_player_set_pause(paused: bool) -> Result<(), String> {
    with_mpv(|mpv| mpv.set_property("pause", paused).map_err(|e| e.to_string()))?
}

#[tauri::command]
pub fn wp_player_seek(secs: f64) -> Result<(), String> {
    with_mpv(move |mpv| {
        mpv.command("seek", &[&secs.to_string(), "absolute+exact"]).map_err(|e| e.to_string())
    })?
}

#[tauri::command]
pub fn wp_player_set_speed(x: f64) -> Result<(), String> {
    with_mpv(move |mpv| mpv.set_property("speed", x).map_err(|e| e.to_string()))?
}

#[tauri::command]
pub fn wp_player_set_audio_track(id: serde_json::Value) -> Result<(), String> {
    let v = json_track_value(&id);
    with_mpv(move |mpv| mpv.set_property("aid", v.as_str()).map_err(|e| e.to_string()))?
}

#[tauri::command]
pub fn wp_player_set_sub_track(id: serde_json::Value) -> Result<(), String> {
    let v = json_track_value(&id);
    with_mpv(move |mpv| mpv.set_property("sid", v.as_str()).map_err(|e| e.to_string()))?
}

fn json_track_value(v: &serde_json::Value) -> String {
    if let Some(n) = v.as_i64() {
        n.to_string()
    } else if let Some(s) = v.as_str() {
        s.to_string()
    } else {
        "auto".to_string()
    }
}

#[tauri::command]
pub fn wp_player_set_sub_delay(secs: f64) -> Result<(), String> {
    with_mpv(move |mpv| mpv.set_property("sub-delay", secs).map_err(|e| e.to_string()))?
}

#[tauri::command]
pub async fn wp_player_add_subtitle(name: String, bytes: Vec<u8>) -> Result<(), String> {
    let dir = std::env::temp_dir().join("colloquium-subs");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let safe: String = name.chars().filter(|c| c.is_alphanumeric() || *c == '.' || *c == '-' || *c == '_').collect();
    let path = dir.join(format!("{}-{}", elapsed_ms() as u64, if safe.is_empty() { "sub.srt".into() } else { safe }));
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    let path_str = path.to_string_lossy().to_string();
    with_mpv(move |mpv| mpv.command("sub-add", &[&path_str, "select"]).map_err(|e| e.to_string()))?
}

#[tauri::command]
pub fn wp_player_get_tracks() -> Result<Vec<TrackInfo>, String> {
    with_mpv(|mpv| read_tracks(mpv))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NowInfo {
    pos: f64,
    ts_ms: f64,
}

#[tauri::command]
pub fn wp_player_now() -> Result<NowInfo, String> {
    with_mpv(|mpv| NowInfo {
        pos: get_f64(mpv, "time-pos").unwrap_or(0.0),
        ts_ms: elapsed_ms(),
    })
}

#[derive(serde::Deserialize)]
pub struct Rect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    #[allow(dead_code)]
    dpr: f64,
}

#[tauri::command]
pub fn wp_player_set_rect(rect: Rect) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let guard = STATE.lock().map_err(|_| "player poisoned".to_string())?;
        if let Some(player) = guard.as_ref() {
            macos::set_rect(&player.window, player.host_view, rect.x, rect.y, rect.w, rect.h);
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = rect;
    Ok(())
}

#[tauri::command]
pub fn wp_player_teardown() -> Result<(), String> {
    let _setup = SETUP.lock().unwrap_or_else(|e| e.into_inner());
    teardown_inner();
    Ok(())
}

fn teardown_inner() {
    let player = STATE.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some(mut player) = player {
        player.running.store(false, Ordering::Relaxed);
        if let Some(join) = player.join.take() {
            let _ = join.join();
        }
        #[cfg(target_os = "macos")]
        macos::remove(&player.window, player.host_view);
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use objc2_core_foundation::{CGPoint, CGRect, CGSize};
    use objc2_foundation::NSString;
    use std::sync::mpsc;
    use std::time::Duration;

    unsafe fn set_transparent(webview: *mut AnyObject) {
        let no: *mut AnyObject = msg_send![class!(NSNumber), numberWithBool: false];
        let key = NSString::from_str("drawsBackground");
        let _: () = msg_send![webview, setValue: no, forKey: &*key];
    }

    pub fn embed(window: &tauri::WebviewWindow) -> Result<usize, String> {
        let (tx, rx) = mpsc::channel::<usize>();
        window
            .with_webview(move |wv| unsafe {
                let webview = wv.inner() as *mut AnyObject;
                set_transparent(webview);
                let superview: *mut AnyObject = msg_send![webview, superview];
                let host: *mut AnyObject = msg_send![class!(NSView), alloc];
                let host: *mut AnyObject = msg_send![host, init];
                let _: () = msg_send![host, setWantsLayer: true];
                let bounds: CGRect = msg_send![superview, bounds];
                let _: () = msg_send![host, setFrame: bounds];
                let below: isize = -1;
                let _: () =
                    msg_send![superview, addSubview: host, positioned: below, relativeTo: webview];
                let _ = tx.send(host as usize);
            })
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(Duration::from_secs(3))
            .map_err(|_| "timed out embedding player view".to_string())
    }

    pub fn set_rect(window: &tauri::WebviewWindow, host: usize, x: f64, y: f64, w: f64, h: f64) {
        let _ = window.run_on_main_thread(move || unsafe {
            let host = host as *mut AnyObject;
            let superview: *mut AnyObject = msg_send![host, superview];
            if superview.is_null() {
                return;
            }
            let bounds: CGRect = msg_send![superview, bounds];
            let flipped_y = bounds.size.height - (y + h);
            let frame = CGRect {
                origin: CGPoint { x, y: flipped_y },
                size: CGSize { width: w, height: h },
            };
            let _: () = msg_send![host, setFrame: frame];
        });
    }

    pub fn remove(window: &tauri::WebviewWindow, host: usize) {
        let _ = window.run_on_main_thread(move || unsafe {
            let host = host as *mut AnyObject;
            let _: () = msg_send![host, removeFromSuperview];
        });
    }
}
