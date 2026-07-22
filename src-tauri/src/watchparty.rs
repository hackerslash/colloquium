use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
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
    #[allow(dead_code)]
    Error { message: String },
}

struct Waker {
    lock: Mutex<bool>,
    cv: Condvar,
}

impl Waker {
    fn new() -> Self {
        Self { lock: Mutex::new(false), cv: Condvar::new() }
    }

    fn wake(&self) {
        let mut g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        *g = true;
        self.cv.notify_all();
    }

    fn wait(&self, timeout: Duration) {
        let g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let (mut g, _) = self.cv.wait_timeout(g, timeout).unwrap_or_else(|e| e.into_inner());
        *g = false;
    }
}

static TARGET_W: AtomicI32 = AtomicI32::new(0);
static TARGET_H: AtomicI32 = AtomicI32::new(0);
static RESIZED: AtomicBool = AtomicBool::new(false);

struct Player {
    mpv: Arc<Mpv>,
    poll_running: Arc<AtomicBool>,
    poll_join: Option<JoinHandle<()>>,
    render_running: Arc<AtomicBool>,
    render_join: Option<JoinHandle<()>>,
    render_ctx: usize,
    #[allow(dead_code)]
    waker: Arc<Waker>,
    #[cfg(target_os = "macos")]
    window: tauri::WebviewWindow,
    #[cfg(target_os = "macos")]
    host_view: usize,
    #[cfg(target_os = "macos")]
    backing_view: usize,
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

extern "C" fn on_render_update(ctx: *mut std::ffi::c_void) {
    if ctx.is_null() {
        return;
    }
    let waker = unsafe { &*(ctx as *const Waker) };
    waker.wake();
}

fn init_blocking(window: tauri::WebviewWindow, channel: Channel<WpEvent>) -> Result<(), String> {
    let _setup = SETUP.lock().unwrap_or_else(|e| e.into_inner());
    teardown_inner();
    TARGET_W.store(0, Ordering::Relaxed);
    TARGET_H.store(0, Ordering::Relaxed);
    RESIZED.store(false, Ordering::Relaxed);

    #[cfg(target_os = "macos")]
    let (host_view, backing_view) = macos::embed(&window)?;

    let mpv = Mpv::with_initializer(|init| {
        let _ = init.set_property("config", false);
        let _ = init.set_property("terminal", false);
        let _ = init.set_property("osc", false);
        let _ = init.set_property("input-default-bindings", false);
        let _ = init.set_property("input-vo-keyboard", false);
        let _ = init.set_property("vo", "libmpv");
        let _ = init.set_property("hr-seek", "yes");
        let _ = init.set_property("keep-open", "yes");
        let _ = init.set_property("hwdec", "auto-safe");
        let _ = init.set_property("cache", "yes");
        Ok(())
    })
    .map_err(|e| format!("mpv init failed: {e}"))?;

    let mpv = Arc::new(mpv);
    let waker = Arc::new(Waker::new());

    let render_ctx = create_render_context(&mpv, &waker)?;

    let poll_running = Arc::new(AtomicBool::new(true));
    let poll_mpv = mpv.clone();
    let poll_flag = poll_running.clone();
    let poll_join = std::thread::spawn(move || poll_loop(poll_mpv, poll_flag, channel));

    let render_running = Arc::new(AtomicBool::new(true));
    let render_flag = render_running.clone();
    let render_waker = waker.clone();
    let ctx_usize = render_ctx as usize;
    #[cfg(target_os = "macos")]
    let render_window = window.clone();
    #[cfg(target_os = "macos")]
    let render_host = host_view;
    let render_join = std::thread::spawn(move || {
        render_loop(
            ctx_usize,
            render_flag,
            render_waker,
            #[cfg(target_os = "macos")]
            render_window,
            #[cfg(target_os = "macos")]
            render_host,
        )
    });

    let mut guard = STATE.lock().unwrap_or_else(|e| e.into_inner());
    *guard = Some(Player {
        mpv,
        poll_running,
        poll_join: Some(poll_join),
        render_running,
        render_join: Some(render_join),
        render_ctx: ctx_usize,
        waker,
        #[cfg(target_os = "macos")]
        window,
        #[cfg(target_os = "macos")]
        host_view,
        #[cfg(target_os = "macos")]
        backing_view,
    });
    #[cfg(not(target_os = "macos"))]
    let _ = window;
    Ok(())
}

fn create_render_context(
    mpv: &Mpv,
    waker: &Arc<Waker>,
) -> Result<*mut libmpv2_sys::mpv_render_context, String> {
    use libmpv2_sys as sys;
    let api = sys::MPV_RENDER_API_TYPE_SW.as_ptr() as *mut std::ffi::c_void;
    let mut params = [
        sys::mpv_render_param {
            type_: sys::mpv_render_param_type_MPV_RENDER_PARAM_API_TYPE,
            data: api,
        },
        sys::mpv_render_param { type_: 0, data: std::ptr::null_mut() },
    ];
    let mut ctx: *mut sys::mpv_render_context = std::ptr::null_mut();
    let err = unsafe {
        sys::mpv_render_context_create(&mut ctx, mpv.ctx.as_ptr(), params.as_mut_ptr())
    };
    if err < 0 || ctx.is_null() {
        return Err(format!("mpv render context create failed: {err}"));
    }
    let waker_ptr = Arc::as_ptr(waker) as *mut std::ffi::c_void;
    unsafe {
        sys::mpv_render_context_set_update_callback(ctx, Some(on_render_update), waker_ptr);
    }
    Ok(ctx)
}

fn render_loop(
    ctx_usize: usize,
    running: Arc<AtomicBool>,
    waker: Arc<Waker>,
    #[cfg(target_os = "macos")] window: tauri::WebviewWindow,
    #[cfg(target_os = "macos")] host: usize,
) {
    use libmpv2_sys as sys;
    let ctx = ctx_usize as *mut sys::mpv_render_context;
    let frame_flag = sys::mpv_render_update_flag_MPV_RENDER_UPDATE_FRAME as u64;

    while running.load(Ordering::Relaxed) {
        waker.wait(Duration::from_millis(200));
        if !running.load(Ordering::Relaxed) {
            break;
        }
        let flags = unsafe { sys::mpv_render_context_update(ctx) };
        let resized = RESIZED.swap(false, Ordering::Relaxed);
        if flags & frame_flag == 0 && !resized {
            continue;
        }
        let w = TARGET_W.load(Ordering::Relaxed);
        let h = TARGET_H.load(Ordering::Relaxed);
        if w <= 0 || h <= 0 {
            continue;
        }
        let stride: usize = (w as usize) * 4;
        let mut pixels: Vec<u32> = vec![0; (w as usize) * (h as usize)];
        let size_arr: [std::os::raw::c_int; 2] = [w, h];
        let fmt = b"rgb0\0";
        let stride_v: usize = stride;
        let mut rparams = [
            sys::mpv_render_param {
                type_: sys::mpv_render_param_type_MPV_RENDER_PARAM_SW_SIZE,
                data: size_arr.as_ptr() as *mut std::ffi::c_void,
            },
            sys::mpv_render_param {
                type_: sys::mpv_render_param_type_MPV_RENDER_PARAM_SW_FORMAT,
                data: fmt.as_ptr() as *mut std::ffi::c_void,
            },
            sys::mpv_render_param {
                type_: sys::mpv_render_param_type_MPV_RENDER_PARAM_SW_STRIDE,
                data: &stride_v as *const usize as *mut std::ffi::c_void,
            },
            sys::mpv_render_param {
                type_: sys::mpv_render_param_type_MPV_RENDER_PARAM_SW_POINTER,
                data: pixels.as_mut_ptr() as *mut std::ffi::c_void,
            },
            sys::mpv_render_param { type_: 0, data: std::ptr::null_mut() },
        ];
        let err = unsafe { sys::mpv_render_context_render(ctx, rparams.as_mut_ptr()) };
        if err < 0 {
            continue;
        }
        #[cfg(target_os = "macos")]
        macos::present(&window, host, pixels, w, h);
        #[cfg(not(target_os = "macos"))]
        let _ = pixels;
    }
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
    dpr: f64,
}

#[tauri::command]
pub fn wp_player_set_rect(rect: Rect) -> Result<(), String> {
    let dpr = if rect.dpr > 0.0 { rect.dpr } else { 1.0 };
    let pw = (rect.w * dpr).round() as i32;
    let ph = (rect.h * dpr).round() as i32;
    TARGET_W.store(pw.max(0), Ordering::Relaxed);
    TARGET_H.store(ph.max(0), Ordering::Relaxed);
    RESIZED.store(true, Ordering::Relaxed);

    let guard = STATE.lock().map_err(|_| "player poisoned".to_string())?;
    if let Some(player) = guard.as_ref() {
        #[cfg(target_os = "macos")]
        macos::set_rect(&player.window, player.host_view, rect.x, rect.y, rect.w, rect.h, dpr);
        player.waker.wake();
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
        player.render_running.store(false, Ordering::Relaxed);
        player.waker.wake();
        if let Some(join) = player.render_join.take() {
            let _ = join.join();
        }
        if player.render_ctx != 0 {
            unsafe {
                libmpv2_sys::mpv_render_context_free(
                    player.render_ctx as *mut libmpv2_sys::mpv_render_context,
                );
            }
        }
        player.poll_running.store(false, Ordering::Relaxed);
        if let Some(join) = player.poll_join.take() {
            let _ = join.join();
        }
        #[cfg(target_os = "macos")]
        macos::remove(&player.window, player.host_view, player.backing_view);
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use objc2_core_foundation::{CGPoint, CGRect, CGSize};
    use objc2_foundation::NSString;
    use std::ffi::c_void;
    use std::sync::mpsc;
    use std::time::Duration;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGColorSpaceCreateDeviceRGB() -> *mut c_void;
        fn CGColorSpaceRelease(space: *mut c_void);
        fn CGDataProviderCreateWithData(
            info: *mut c_void,
            data: *const c_void,
            size: usize,
            release: Option<extern "C" fn(*mut c_void, *const c_void, usize)>,
        ) -> *mut c_void;
        fn CGDataProviderRelease(provider: *mut c_void);
        fn CGImageCreate(
            width: usize,
            height: usize,
            bits_per_component: usize,
            bits_per_pixel: usize,
            bytes_per_row: usize,
            space: *mut c_void,
            bitmap_info: u32,
            provider: *mut c_void,
            decode: *const f64,
            should_interpolate: bool,
            intent: i32,
        ) -> *mut c_void;
        fn CGImageRelease(image: *mut c_void);
    }

    const K_CG_IMAGE_ALPHA_NONE_SKIP_LAST: u32 = 5;

    extern "C" fn release_pixels(info: *mut c_void, _data: *const c_void, _size: usize) {
        if !info.is_null() {
            unsafe { drop(Box::from_raw(info as *mut Vec<u32>)) };
        }
    }

    unsafe fn set_transparent(webview: *mut AnyObject) {
        let no: *mut AnyObject = msg_send![class!(NSNumber), numberWithBool: false];
        let key = NSString::from_str("drawsBackground");
        let _: () = msg_send![webview, setValue: no, forKey: &*key];
    }

    unsafe fn set_black_layer(view: *mut AnyObject) {
        let _: () = msg_send![view, setWantsLayer: true];
        let layer: *mut AnyObject = msg_send![view, layer];
        if !layer.is_null() {
            let black: *mut AnyObject = msg_send![class!(NSColor), blackColor];
            let cg: *mut AnyObject = msg_send![black, CGColor];
            let _: () = msg_send![layer, setBackgroundColor: cg];
        }
    }

    pub fn embed(window: &tauri::WebviewWindow) -> Result<(usize, usize), String> {
        let (tx, rx) = mpsc::channel::<(usize, usize)>();
        window
            .with_webview(move |wv| unsafe {
                let webview = wv.inner() as *mut AnyObject;
                set_transparent(webview);
                let superview: *mut AnyObject = msg_send![webview, superview];
                let bounds: CGRect = msg_send![superview, bounds];
                let below: isize = -1;

                let backing: *mut AnyObject = msg_send![class!(NSView), alloc];
                let backing: *mut AnyObject = msg_send![backing, init];
                set_black_layer(backing);
                let _: () = msg_send![backing, setFrame: bounds];
                let autoresize: usize = 2 | 16;
                let _: () = msg_send![backing, setAutoresizingMask: autoresize];
                let _: () = msg_send![superview, addSubview: backing, positioned: below, relativeTo: webview];

                let host: *mut AnyObject = msg_send![class!(NSView), alloc];
                let host: *mut AnyObject = msg_send![host, init];
                set_black_layer(host);
                let layer: *mut AnyObject = msg_send![host, layer];
                if !layer.is_null() {
                    let gravity = NSString::from_str("resizeAspect");
                    let _: () = msg_send![layer, setContentsGravity: &*gravity];
                }
                let _: () = msg_send![host, setFrame: bounds];
                let _: () = msg_send![superview, addSubview: host, positioned: below, relativeTo: webview];

                let _ = tx.send((host as usize, backing as usize));
            })
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(Duration::from_secs(3))
            .map_err(|_| "timed out embedding player view".to_string())
    }

    pub fn present(window: &tauri::WebviewWindow, host: usize, pixels: Vec<u32>, w: i32, h: i32) {
        let _ = window.run_on_main_thread(move || unsafe {
            let host = host as *mut AnyObject;
            let layer: *mut AnyObject = msg_send![host, layer];
            if layer.is_null() {
                return;
            }
            let stride = (w as usize) * 4;
            let size = (w as usize) * (h as usize) * 4;
            let boxed = Box::into_raw(Box::new(pixels));
            let data = (*boxed).as_ptr() as *const c_void;
            let provider =
                CGDataProviderCreateWithData(boxed as *mut c_void, data, size, Some(release_pixels));
            let space = CGColorSpaceCreateDeviceRGB();
            let image = CGImageCreate(
                w as usize,
                h as usize,
                8,
                32,
                stride,
                space,
                K_CG_IMAGE_ALPHA_NONE_SKIP_LAST,
                provider,
                std::ptr::null(),
                false,
                0,
            );
            if !image.is_null() {
                let _: () = msg_send![layer, setContents: image as *mut AnyObject];
            }
            CGImageRelease(image);
            CGDataProviderRelease(provider);
            CGColorSpaceRelease(space);
        });
    }

    pub fn set_rect(
        window: &tauri::WebviewWindow,
        host: usize,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        dpr: f64,
    ) {
        let _ = window.run_on_main_thread(move || unsafe {
            let host = host as *mut AnyObject;
            let superview: *mut AnyObject = msg_send![host, superview];
            if superview.is_null() {
                return;
            }
            let bounds: CGRect = msg_send![superview, bounds];
            let flipped: bool = msg_send![superview, isFlipped];
            let origin_y = if flipped { y } else { bounds.size.height - (y + h) };
            let frame = CGRect {
                origin: CGPoint { x, y: origin_y },
                size: CGSize { width: w, height: h },
            };
            let _: () = msg_send![host, setFrame: frame];
            let layer: *mut AnyObject = msg_send![host, layer];
            if !layer.is_null() {
                let _: () = msg_send![layer, setContentsScale: dpr];
            }
        });
    }

    pub fn remove(window: &tauri::WebviewWindow, host: usize, backing: usize) {
        let _ = window.run_on_main_thread(move || unsafe {
            let host = host as *mut AnyObject;
            let backing = backing as *mut AnyObject;
            let _: () = msg_send![host, removeFromSuperview];
            let _: () = msg_send![backing, removeFromSuperview];
        });
    }
}
