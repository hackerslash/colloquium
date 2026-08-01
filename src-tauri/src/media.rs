//! Makes an arbitrary remote video URL playable in a plain HTML <video>, using
//! the bundled ffmpeg/ffprobe sidecars as child processes. Two moving parts:
//!
//!   * a loopback HTTP server that proxies the remote source over plain http
//!     (our ffmpeg build has no TLS — see `-protocols`) and serves back the HLS
//!     segments ffmpeg writes into the app cache dir;
//!   * one ffmpeg child per *window* — a remux/transcode starting at some source
//!     position. A window is torn down and respawned only when the user scrubs
//!     past what has been produced; drift corrections stay inside it and are
//!     plain `currentTime` writes with no ffmpeg involvement.
//!
//! There is deliberately no per-OS presentation code here: frames only ever
//! reach the screen through the webview's own <video> element. The single `cfg`
//! is `no_window`, which stops a console window flashing on Windows.

use std::collections::HashMap;
use std::convert::Infallible;
use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use bytes::Bytes;
use futures_util::TryStreamExt;
use http_body_util::{combinators::BoxBody, BodyExt, Full, StreamBody};
use hyper::body::Frame;
use hyper::header::{
    HeaderValue, ACCEPT_RANGES, ACCESS_CONTROL_ALLOW_HEADERS, ACCESS_CONTROL_ALLOW_METHODS,
    ACCESS_CONTROL_ALLOW_ORIGIN, ACCESS_CONTROL_EXPOSE_HEADERS, CACHE_CONTROL, CONTENT_LENGTH,
    CONTENT_RANGE, CONTENT_TYPE, RANGE,
};
use hyper::{Method, Request, Response, StatusCode};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// Segment length. Also the forced-keyframe interval when transcoding, so
/// segments land on real keyframes in both pipelines.
const SEGMENT_SEC: u32 = 4;
/// How long to wait for ffmpeg to produce a first segment before giving up.
const FIRST_SEGMENT_TIMEOUT: Duration = Duration::from_secs(45);

/// How far ahead of the playhead a window is allowed to run, as a multiple of
/// realtime, and how much it may read flat out first.
///
/// Unthrottled, a window is not slow — it is far too fast. Measured on a 1.6 GB
/// 720p source: 19.5 minutes of video produced in the first 30 seconds (~91x
/// realtime), 130 Mbit/s sustained, and the whole rest of the film in the cache
/// dir within about a minute and a half. That competes for bandwidth with the
/// very call it is playing into, which is what makes playback stutter on a
/// machine with plenty of decode headroom. At 1.5x the lead settles at 8-16s.
///
/// The burst is what keeps startup and post-seek restarts quick: the first
/// stretch is still read as fast as the link allows, so hls.js gets a full
/// forward buffer immediately and only the steady state is capped.
const READ_RATE: &str = "1.5";
const READ_BURST_SEC: &str = "30";

// ---------------------------------------------------------------- sidecar glue

/// Resolves a bundled sidecar. `tauri-build` copies `externalBin` next to the
/// dev binary with the target triple stripped, so the same join works in
/// `tauri dev` and in a packaged app. The Tauri helper (not
/// `std::env::current_exe`) is what handles the macOS .app layout.
fn tool(name: &str) -> Result<PathBuf, String> {
    let exe = tauri::utils::platform::current_exe().map_err(|e| e.to_string())?;
    let dir = exe.parent().ok_or("no parent dir")?;
    let mut p = dir.join(name);
    if cfg!(windows) {
        p.set_extension("exe");
    }
    Ok(p)
}

fn no_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

/// The hls muxer finds its output directory with `strrchr(m3u8_name, '/')`, so a
/// backslashed path writes `init.mp4` to the cwd and every fragment then 404s.
fn ff_path(p: &Path) -> String {
    let s = p.to_string_lossy();
    if cfg!(windows) {
        s.replace('\\', "/")
    } else {
        s.into_owned()
    }
}

fn base_command(name: &str) -> Result<Command, String> {
    let mut cmd = Command::new(tool(name)?);
    // Both -nostdin and a null stdin: ffmpeg otherwise treats the inherited
    // stdin as interactive input and can consume it.
    cmd.stdin(Stdio::null());
    no_window(&mut cmd);
    Ok(cmd)
}

/// Runs a sidecar to completion and returns stdout.
fn run(name: &str, args: &[&str]) -> Result<Vec<u8>, String> {
    let mut cmd = base_command(name)?;
    let out = cmd
        .args(args)
        .output()
        .map_err(|e| format!("{name}: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "{name} failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(out.stdout)
}

// -------------------------------------------------------------------- sessions

#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StreamMode {
    Copy,
    Encode,
}

/// What the frontend decided to do with each elementary stream. `container` is
/// part of the same object on the TS side but only matters there — a `direct`
/// plan never reaches `media_open_window`.
#[derive(Clone, Copy, Debug, Deserialize)]
pub struct Plan {
    pub video: StreamMode,
    pub audio: StreamMode,
}

struct Session {
    token: String,
    source: String,
    dir: PathBuf,
    generation: u32,
    child: Option<Child>,
    /// The subtitle extraction in flight. Held so closing the session kills it —
    /// otherwise a full read of a multi-gigabyte source outlives the party.
    sub_child: Option<Child>,
    /// Source seconds the extraction has scanned, for the UI's progress bar.
    sub_progress_sec: f64,
    probe: Option<serde_json::Value>,
}

fn reap(mut child: Child) {
    let _ = child.kill();
    // Waited on — an unwaited child stays a zombie for the app's lifetime.
    let _ = child.wait();
}

fn kill_child(slot: &mut Option<Child>) {
    if let Some(child) = slot.take() {
        reap(child);
    }
}

impl Session {
    /// Kills the current ffmpeg without disturbing the session, so the next
    /// generation can start clean.
    fn stop_child(&mut self) {
        kill_child(&mut self.child);
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.stop_child();
        kill_child(&mut self.sub_child);
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[derive(Default)]
pub struct MediaState {
    port: OnceLock<u16>,
    sessions: Mutex<HashMap<String, Session>>,
    encoder: OnceLock<String>,
}

fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    OsRng.fill_bytes(&mut buf);
    hex::encode(buf)
}

/// Resolves a session by id *and* token. Every generated URL carries the token,
/// so another local process that guesses the port still cannot read the user's
/// media. Returns the two things request handling needs, so the lock is never
/// held across an await.
fn lookup(app: &AppHandle, id: &str, token: &str) -> Option<(String, PathBuf)> {
    let state = app.state::<MediaState>();
    let sessions = state.sessions.lock().unwrap();
    let s = sessions.get(id)?;
    if s.token != token {
        return None;
    }
    Some((s.source.clone(), s.dir.clone()))
}

// ---------------------------------------------------------------------- routing

#[derive(Debug, PartialEq)]
enum Route {
    Src {
        id: String,
        token: String,
    },
    Playlist {
        id: String,
        token: String,
        generation: u32,
    },
    Segment {
        id: String,
        token: String,
        generation: u32,
        file: String,
    },
    NotFound,
}

/// Only the exact shapes we generate are routable, and segment names must match
/// what the hls muxer produces (`init.mp4` / five-digit `.m4s`). Validating the
/// filename by pattern rather than scanning for `..` means no traversal can be
/// expressed at all — and it also excludes ffmpeg's in-progress `.m4s.tmp`
/// files, so a half-written segment can never be served.
fn route(path: &str) -> Route {
    let parts: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    match parts.as_slice() {
        ["s", id, token, "src"] => Route::Src {
            id: (*id).to_string(),
            token: (*token).to_string(),
        },
        ["s", id, token, "w", generation, file] => {
            let Ok(generation) = generation.parse::<u32>() else {
                return Route::NotFound;
            };
            if *file == "index.m3u8" {
                return Route::Playlist {
                    id: (*id).to_string(),
                    token: (*token).to_string(),
                    generation,
                };
            }
            if is_segment_name(file) {
                return Route::Segment {
                    id: (*id).to_string(),
                    token: (*token).to_string(),
                    generation,
                    file: (*file).to_string(),
                };
            }
            Route::NotFound
        }
        _ => Route::NotFound,
    }
}

fn is_segment_name(file: &str) -> bool {
    if file == "init.mp4" {
        return true;
    }
    match file.strip_suffix(".m4s") {
        Some(stem) => !stem.is_empty() && stem.bytes().all(|b| b.is_ascii_digit()),
        None => false,
    }
}

/// Parses a single byte range against a known length, returning an inclusive
/// `(start, end)`. Multi-range and unsatisfiable requests return `None`, which
/// the caller answers with the whole body.
fn parse_range(header: &str, len: u64) -> Option<(u64, u64)> {
    let spec = header.trim().strip_prefix("bytes=")?.trim();
    if spec.contains(',') || len == 0 {
        return None;
    }
    let (first, last) = spec.split_once('-')?;
    let (start, end) = if first.is_empty() {
        // Suffix form: the last N bytes.
        let n: u64 = last.trim().parse().ok()?;
        if n == 0 {
            return None;
        }
        (len.saturating_sub(n), len - 1)
    } else {
        let start: u64 = first.trim().parse().ok()?;
        let end = if last.trim().is_empty() {
            len - 1
        } else {
            last.trim().parse::<u64>().ok()?.min(len - 1)
        };
        (start, end)
    };
    if start > end || start >= len {
        return None;
    }
    Some((start, end))
}

/// hls.js and AVPlayer treat a playlist with no `#EXT-X-ENDLIST` as live and
/// jump to the live edge — i.e. to wherever ffmpeg has got to, instead of the
/// start of the window we just asked for. `#EXT-X-START` pins playback to the
/// beginning of the window. Idempotent, since ffmpeg rewrites the playlist on
/// every append and we re-run this on every request.
fn rewrite_playlist(text: &str) -> String {
    const START_TAG: &str = "#EXT-X-START:TIME-OFFSET=0,PRECISE=YES";
    if text.contains("#EXT-X-START") {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len() + START_TAG.len() + 1);
    let mut injected = false;
    for line in text.lines() {
        out.push_str(line);
        out.push('\n');
        if !injected && line.starts_with("#EXT-X-VERSION") {
            out.push_str(START_TAG);
            out.push('\n');
            injected = true;
        }
    }
    if !injected {
        // No version tag yet (ffmpeg has only written `#EXTM3U`); prepending
        // keeps the file valid — the tag order after `#EXTM3U` is free.
        return format!("{START_TAG}\n{out}");
    }
    out
}

// ----------------------------------------------------------------- http server

type Body = BoxBody<Bytes, std::io::Error>;

fn full(bytes: impl Into<Bytes>) -> Body {
    Full::new(bytes.into()).map_err(|e: Infallible| match e {}).boxed()
}

fn empty() -> Body {
    full(Bytes::new())
}

/// hls.js fetches segments cross-origin (from `tauri://localhost` in a packaged
/// app, `http://localhost:1420` in dev), and needs the length headers exposed
/// to do range/progress accounting. Safe to allow any origin because every URL
/// is unguessable without the session token.
fn cors(res: &mut Response<Body>) {
    let h = res.headers_mut();
    h.insert(ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    h.insert(
        ACCESS_CONTROL_EXPOSE_HEADERS,
        HeaderValue::from_static("Content-Length, Content-Range"),
    );
}

fn status_only(code: StatusCode) -> Response<Body> {
    let mut res = Response::new(empty());
    *res.status_mut() = code;
    cors(&mut res);
    res
}

fn preflight() -> Response<Body> {
    let mut res = status_only(StatusCode::NO_CONTENT);
    let h = res.headers_mut();
    h.insert(ACCESS_CONTROL_ALLOW_METHODS, HeaderValue::from_static("GET, HEAD, OPTIONS"));
    h.insert(ACCESS_CONTROL_ALLOW_HEADERS, HeaderValue::from_static("Range"));
    res
}

fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

/// Fetches the remote source and re-serves it over plain http, forwarding
/// `Range` upstream so ffmpeg keeps full seek support. This is the whole reason
/// ffmpeg needs no TLS backend, and it means ffmpeg never touches the network
/// itself. The body is streamed, never buffered — sources are routinely
/// multi-gigabyte.
async fn proxy_source(source: &str, range: Option<&HeaderValue>) -> Response<Body> {
    let mut req = http_client().get(source);
    if let Some(value) = range {
        req = req.header(RANGE, value.clone());
    }
    let upstream = match req.send().await {
        Ok(r) => r,
        Err(_) => return status_only(StatusCode::BAD_GATEWAY),
    };

    let mut builder = Response::builder().status(upstream.status());
    for name in [CONTENT_TYPE, CONTENT_LENGTH, CONTENT_RANGE, ACCEPT_RANGES] {
        if let Some(value) = upstream.headers().get(&name) {
            builder = builder.header(name, value.clone());
        }
    }
    let stream = upstream
        .bytes_stream()
        .map_ok(Frame::data)
        .map_err(std::io::Error::other);
    let mut res = builder
        .body(StreamBody::new(stream).boxed())
        .unwrap_or_else(|_| status_only(StatusCode::BAD_GATEWAY));
    cors(&mut res);
    res
}

async fn serve_playlist(path: &Path) -> Response<Body> {
    let Ok(text) = tokio::fs::read_to_string(path).await else {
        return status_only(StatusCode::NOT_FOUND);
    };
    let mut res = Response::new(full(rewrite_playlist(&text)));
    let h = res.headers_mut();
    h.insert(CONTENT_TYPE, HeaderValue::from_static("application/vnd.apple.mpegurl"));
    h.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    cors(&mut res);
    res
}

async fn serve_file(path: &Path, mime: &'static str, range: Option<&HeaderValue>) -> Response<Body> {
    let Ok(data) = tokio::fs::read(path).await else {
        return status_only(StatusCode::NOT_FOUND);
    };
    let len = data.len() as u64;
    let slice = range
        .and_then(|v| v.to_str().ok())
        .and_then(|s| parse_range(s, len));

    let mut res = match slice {
        Some((start, end)) => {
            let body = Bytes::from(data).slice(start as usize..=end as usize);
            let mut res = Response::new(full(body));
            *res.status_mut() = StatusCode::PARTIAL_CONTENT;
            res.headers_mut().insert(
                CONTENT_RANGE,
                HeaderValue::from_str(&format!("bytes {start}-{end}/{len}")).unwrap(),
            );
            res
        }
        None => Response::new(full(data)),
    };
    let h = res.headers_mut();
    h.insert(CONTENT_TYPE, HeaderValue::from_static(mime));
    h.insert(ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    cors(&mut res);
    res
}

async fn serve(app: &AppHandle, req: Request<hyper::body::Incoming>) -> Response<Body> {
    if req.method() == Method::OPTIONS {
        return preflight();
    }
    if req.method() != Method::GET && req.method() != Method::HEAD {
        return status_only(StatusCode::METHOD_NOT_ALLOWED);
    }
    let range = req.headers().get(RANGE).cloned();
    match route(req.uri().path()) {
        Route::Src { id, token } => match lookup(app, &id, &token) {
            Some((source, _)) => proxy_source(&source, range.as_ref()).await,
            None => status_only(StatusCode::NOT_FOUND),
        },
        Route::Playlist { id, token, generation } => match lookup(app, &id, &token) {
            Some((_, dir)) => serve_playlist(&window_dir(&dir, generation).join("index.m3u8")).await,
            None => status_only(StatusCode::NOT_FOUND),
        },
        Route::Segment { id, token, generation, file } => match lookup(app, &id, &token) {
            Some((_, dir)) => {
                serve_file(&window_dir(&dir, generation).join(file), "video/mp4", range.as_ref()).await
            }
            None => status_only(StatusCode::NOT_FOUND),
        },
        Route::NotFound => status_only(StatusCode::NOT_FOUND),
    }
}

/// Starts the loopback server on first use and returns its port.
///
/// Bound explicitly to `127.0.0.1` (never `0.0.0.0`/`::`) — that is what keeps
/// the macOS application firewall and Windows Firewall from ever prompting. The
/// port is whatever the OS assigns; nothing is hardcoded.
async fn ensure_server(app: &AppHandle) -> Result<u16, String> {
    let state = app.state::<MediaState>();
    if let Some(port) = state.port.get() {
        return Ok(*port);
    }
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))
        .map_err(|e| format!("loopback bind failed: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| e.to_string())?
        .port();

    // Two concurrent opens can both get here; whoever loses the `set` race drops
    // its listener and uses the winner's port.
    if state.port.set(port).is_err() {
        return Ok(*state.port.get().unwrap());
    }
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let listener = tokio::net::TcpListener::from_std(listener).map_err(|e| e.to_string())?;

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let stream = match listener.accept().await {
                Ok((stream, _)) => stream,
                // Transient (EMFILE and friends) — back off rather than spin.
                Err(_) => {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    continue;
                }
            };
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let io = hyper_util::rt::TokioIo::new(stream);
                let service = hyper::service::service_fn(move |req| {
                    let app = app.clone();
                    async move { Ok::<_, Infallible>(serve(&app, req).await) }
                });
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(io, service)
                    .await;
            });
        }
    });
    Ok(port)
}

// ------------------------------------------------------------------ ffmpeg runs

fn window_dir(session_dir: &Path, generation: u32) -> PathBuf {
    session_dir.join(generation.to_string())
}

/// Which hardware H.264 encoder this machine actually has, found by trying each
/// one on a one-frame synthetic clip. A platform table would be wrong in both
/// directions — some Windows boxes have no working Media Foundation encoder,
/// and the set ffmpeg was configured with can change independently of the OS.
fn pick_encoder(state: &MediaState) -> String {
    if let Some(enc) = state.encoder.get() {
        return enc.clone();
    }
    const CANDIDATES: [&str; 5] = [
        "h264_videotoolbox",
        "h264_nvenc",
        "h264_qsv",
        "h264_amf",
        "h264_mf",
    ];
    let chosen = CANDIDATES
        .iter()
        .find(|enc| {
            run(
                "ffmpeg",
                &[
                    "-hide_banner", "-loglevel", "error", "-nostdin",
                    "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=1",
                    "-frames:v", "1", "-c:v", enc, "-f", "null", "-",
                ],
            )
            .is_ok()
        })
        .copied()
        // Software H.264 is not in our LGPL build, so there is no fallback
        // encoder to name. Returning libx264 would fail loudly at spawn, which
        // is the honest outcome: this machine cannot transcode.
        .unwrap_or("libx264");
    let _ = state.encoder.set(chosen.to_string());
    chosen.to_string()
}

/// Target H.264 bitrate for a transcode, from the source's frame size. Not
/// capped by the source bitrate: HEVC/AV1 reach the same quality at well under
/// what H.264 needs, so copying the input's number would visibly degrade it.
fn target_bitrate_kbps(probe: Option<&serde_json::Value>) -> u32 {
    let pixels = probe
        .and_then(|p| p.get("streams")?.as_array()?.iter().find_map(|s| {
            if s.get("codec_type")?.as_str()? != "video" {
                return None;
            }
            Some(s.get("width")?.as_u64()? * s.get("height")?.as_u64()?)
        }))
        .unwrap_or(1920 * 1080);
    match pixels {
        p if p <= 640 * 480 => 1_500,
        p if p <= 1280 * 720 => 3_000,
        p if p <= 1920 * 1080 => 6_000,
        p if p <= 2560 * 1440 => 10_000,
        _ => 16_000,
    }
}

/// True once the playlist lists a complete segment. Because the muxer runs with
/// `-hls_flags temp_file` a segment only appears in the playlist after it has
/// been renamed into place, so this is also the point at which the window is
/// safe to serve.
fn playlist_ready(playlist: &Path) -> bool {
    std::fs::read_to_string(playlist)
        .map(|t| t.contains("#EXTINF"))
        .unwrap_or(false)
}

/// The real source position of the first frame in a window.
///
/// This has to be *probed*, never computed. `-ss` before `-i` with `-c:v copy`
/// snaps to the preceding keyframe, so asking for 7 s on a file with a 10 s GOP
/// can start anywhere up to 10 s earlier — and every peer lands somewhere
/// different. Duration arithmetic doesn't recover it either (re-encoded audio
/// doesn't start on the video keyframe), which is why the ffmpeg run uses
/// `-copyts`: it leaves the true timestamp in the output for ffprobe to read.
fn probe_offset_sec(playlist: &Path, fallback: f64) -> f64 {
    let out = run(
        "ffprobe",
        &[
            "-v", "error",
            "-show_entries", "format=start_time",
            "-of", "default=nw=1:nk=1",
            &playlist.to_string_lossy(),
        ],
    );
    match out {
        Ok(bytes) => String::from_utf8_lossy(&bytes)
            .trim()
            .parse::<f64>()
            // A keyframe-snapped window starts at or before the requested
            // position, so the request is the closest honest guess available.
            .unwrap_or(fallback),
        Err(_) => fallback,
    }
}

fn ffmpeg_log_tail(dir: &Path) -> String {
    std::fs::read_to_string(dir.join("ffmpeg.log"))
        .map(|s| s.lines().rev().take(4).collect::<Vec<_>>().join(" / "))
        .unwrap_or_default()
}

fn spawn_window(
    state: &MediaState,
    src_url: &str,
    out_dir: &Path,
    plan: Plan,
    start_sec: f64,
    audio_stream: u32,
    probe: Option<&serde_json::Value>,
) -> Result<Child, String> {
    // The hls muxer will not create its own output directory, and fails with a
    // misleading "Failed to open segment 'init.mp4'" if it is missing.
    std::fs::create_dir_all(out_dir).map_err(|e| format!("cache dir: {e}"))?;

    let start = format!("{start_sec:.3}");
    let audio_map = format!("0:a:{audio_stream}?");
    let segments = out_dir.join("%05d.m4s");
    let playlist = out_dir.join("index.m3u8");
    let hls_time = SEGMENT_SEC.to_string();

    let mut cmd = base_command("ffmpeg")?;
    cmd.args(["-hide_banner", "-loglevel", "error", "-nostdin", "-y"]);
    cmd.args(["-readrate", READ_RATE, "-readrate_initial_burst", READ_BURST_SEC]);
    cmd.args(["-ss", &start, "-copyts", "-i", src_url]);
    cmd.args(["-map", "0:v:0", "-map", &audio_map, "-sn", "-dn"]);

    let encoder;
    let bitrate;
    let maxrate;
    let bufsize;
    let keyframes;
    match plan.video {
        StreamMode::Copy => {
            cmd.args(["-c:v", "copy"]);
        }
        StreamMode::Encode => {
            encoder = pick_encoder(state);
            let kbps = target_bitrate_kbps(probe);
            bitrate = format!("{kbps}k");
            maxrate = format!("{}k", kbps * 3 / 2);
            bufsize = format!("{}k", kbps * 3);
            keyframes = format!("expr:gte(t,n_forced*{SEGMENT_SEC})");
            cmd.args(["-c:v", &encoder]);
            cmd.args(["-profile:v", "high", "-pix_fmt", "yuv420p"]);
            cmd.args(["-b:v", &bitrate, "-maxrate", &maxrate, "-bufsize", &bufsize]);
            cmd.args(["-force_key_frames", &keyframes]);
        }
    }
    match plan.audio {
        StreamMode::Copy => {
            cmd.args(["-c:a", "copy"]);
        }
        // Downmixed: a 5.1 AAC track in fMP4 is not reliably decodable in either
        // webview, and every source needing an audio encode is surround.
        StreamMode::Encode => {
            cmd.args(["-c:a", "aac", "-b:a", "192k", "-ac", "2"]);
        }
    }

    cmd.args(["-f", "hls", "-hls_time", &hls_time, "-hls_playlist_type", "event"]);
    cmd.args(["-hls_flags", "independent_segments+temp_file"]);
    cmd.args(["-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4"]);
    cmd.arg("-hls_segment_filename").arg(ff_path(&segments));
    cmd.args(["-start_number", "0"]);
    cmd.arg(ff_path(&playlist));

    // ffmpeg's diagnostics are the only way to tell a codec problem from a
    // network one, and there is no console to read them from in a packaged app.
    if let Ok(log) = std::fs::File::create(out_dir.join("ffmpeg.log")) {
        cmd.stderr(Stdio::from(log));
    }
    cmd.spawn().map_err(|e| format!("ffmpeg spawn: {e}"))
}

// -------------------------------------------------------------------- commands

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenResult {
    session_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowResult {
    playlist_url: String,
    offset_sec: f64,
}

fn check_source(source: &str) -> Result<(), String> {
    if source.starts_with("http://") || source.starts_with("https://") {
        Ok(())
    } else {
        // `streamUrl` arrives from another peer over the data channel, so this
        // is a trust boundary: without it a party could point the proxy at
        // something that is not a remote stream at all.
        Err("only http(s) sources are supported".into())
    }
}

/// Opens a session: allocates the token and cache dir and starts the loopback
/// server. Nothing is decoded yet — the caller probes next, then decides a plan.
#[tauri::command]
pub async fn media_open(app: AppHandle, source: String) -> Result<OpenResult, String> {
    check_source(&source)?;
    ensure_server(&app).await?;
    let id = random_hex(8);
    let token = random_hex(16);
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("wp")
        .join(&id);

    app.state::<MediaState>().sessions.lock().unwrap().insert(
        id.clone(),
        Session {
            token,
            source,
            dir,
            generation: 0,
            child: None,
            sub_child: None,
            sub_progress_sec: 0.0,
            probe: None,
        },
    );
    Ok(OpenResult { session_id: id })
}

/// ffprobe's report on the source, verbatim. Interpreting it — which streams
/// exist, which of them this webview can decode — is the frontend's job.
#[tauri::command]
pub async fn media_probe(app: AppHandle, session_id: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<MediaState>();
        let port = *state.port.get().ok_or("server not started")?;
        let token = {
            let sessions = state.sessions.lock().unwrap();
            sessions.get(&session_id).ok_or("no such session")?.token.clone()
        };
        let url = format!("http://127.0.0.1:{port}/s/{session_id}/{token}/src");
        let out = run(
            "ffprobe",
            &[
                "-v", "error",
                "-print_format", "json",
                "-show_format", "-show_streams", "-show_chapters",
                &url,
            ],
        )?;
        let json: serde_json::Value =
            serde_json::from_slice(&out).map_err(|e| format!("ffprobe json: {e}"))?;

        if let Some(s) = state.sessions.lock().unwrap().get_mut(&session_id) {
            s.probe = Some(json.clone());
        }
        Ok(json)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Starts a new remux/transcode window at `start_sec`, replacing any previous
/// one. Returns the probed source position of the window's first frame.
#[tauri::command]
pub async fn media_open_window(
    app: AppHandle,
    session_id: String,
    plan: Plan,
    start_sec: f64,
    audio_stream: Option<u32>,
) -> Result<WindowResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let start_sec = start_sec.max(0.0);
        let state = app.state::<MediaState>();
        let port = *state.port.get().ok_or("server not started")?;

        let (token, out_dir, generation, probe, src_url, stale_dir) = {
            let mut sessions = state.sessions.lock().unwrap();
            let s = sessions.get_mut(&session_id).ok_or("no such session")?;
            s.stop_child();
            let stale = (s.generation > 0).then(|| window_dir(&s.dir, s.generation));
            s.generation += 1;
            let generation = s.generation;
            let src_url = format!(
                "http://127.0.0.1:{port}/s/{session_id}/{}/src",
                s.token
            );
            (
                s.token.clone(),
                window_dir(&s.dir, generation),
                generation,
                s.probe.clone(),
                src_url,
                stale,
            )
        };

        // A window runs to the end of the source, so its segments are a full
        // remux of everything after its start point. Without this, every scrub
        // would leave another copy of the rest of the film on disk. Safe now
        // that the child writing them is dead, and done before the next spawn
        // so peak usage stays at one window.
        if let Some(dir) = stale_dir {
            let _ = std::fs::remove_dir_all(dir);
        }

        let child = spawn_window(
            &state,
            &src_url,
            &out_dir,
            plan,
            start_sec,
            audio_stream.unwrap_or(0),
            probe.as_ref(),
        )?;

        // Hand the child to the session immediately, so a session closed while
        // we are still waiting for the first segment still kills it.
        {
            let mut sessions = state.sessions.lock().unwrap();
            let s = sessions.get_mut(&session_id).ok_or("no such session")?;
            if s.generation != generation {
                // A newer window started while we were spawning; that one owns
                // the session now.
                let mut child = child;
                let _ = child.kill();
                let _ = child.wait();
                return Err("superseded".into());
            }
            s.child = Some(child);
        }

        let playlist = out_dir.join("index.m3u8");
        let deadline = Instant::now() + FIRST_SEGMENT_TIMEOUT;
        loop {
            if playlist_ready(&playlist) {
                break;
            }
            let exited = {
                let mut sessions = state.sessions.lock().unwrap();
                let s = sessions.get_mut(&session_id).ok_or("no such session")?;
                if s.generation != generation {
                    return Err("superseded".into());
                }
                match s.child.as_mut() {
                    Some(child) => child.try_wait().map_err(|e| e.to_string())?,
                    None => return Err("superseded".into()),
                }
            };
            if let Some(exit) = exited {
                // Order matters: a very short source can finish before we first
                // look, in which case the playlist check above already broke.
                if playlist_ready(&playlist) {
                    break;
                }
                return Err(format!(
                    "ffmpeg exited ({}) without producing output. {}",
                    exit.code().unwrap_or(-1),
                    ffmpeg_log_tail(&out_dir)
                ));
            }
            if Instant::now() >= deadline {
                return Err(format!(
                    "timed out waiting for the first segment. {}",
                    ffmpeg_log_tail(&out_dir)
                ));
            }
            std::thread::sleep(Duration::from_millis(100));
        }

        Ok(WindowResult {
            playlist_url: format!(
                "http://127.0.0.1:{port}/s/{session_id}/{token}/w/{generation}/index.m3u8"
            ),
            offset_sec: probe_offset_sec(&playlist, start_sec),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Extracts one text subtitle stream as WebVTT. `stream_index` is the ordinal
/// among subtitle streams (`0:s:N`), not an absolute ffprobe index — see the
/// track-id note in the wire protocol.
///
/// Bitmap subtitles (PGS, VOBSUB) cannot become WebVTT at all; the frontend
/// filters those out rather than calling this and failing.
///
/// Unavoidably a full read of the source — cues are interleaved through the whole
/// container, so there is no seeking to just the subtitle packets, and a 4K file
/// takes minutes. Hence the cues going to a file and `-progress` taking stdout,
/// which `media_extract_progress` polls.
#[tauri::command]
pub async fn media_extract_subtitle(
    app: AppHandle,
    session_id: String,
    stream_index: u32,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<MediaState>();
        let port = *state.port.get().ok_or("server not started")?;
        let (token, dir) = {
            let mut sessions = state.sessions.lock().unwrap();
            let s = sessions.get_mut(&session_id).ok_or("no such session")?;
            // Only one extraction at a time: switching tracks mid-read otherwise
            // leaves two full downloads racing on the same link.
            kill_child(&mut s.sub_child);
            s.sub_progress_sec = 0.0;
            (s.token.clone(), s.dir.clone())
        };
        std::fs::create_dir_all(&dir).map_err(|e| format!("cache dir: {e}"))?;
        let out_path = dir.join(format!("sub{stream_index}.vtt"));

        let url = format!("http://127.0.0.1:{port}/s/{session_id}/{token}/src");
        let map = format!("0:s:{stream_index}");
        let mut cmd = base_command("ffmpeg")?;
        cmd.args(["-hide_banner", "-loglevel", "error", "-nostdin", "-y"]);
        cmd.args(["-progress", "pipe:1"]);
        cmd.args(["-i", &url, "-map", &map, "-f", "webvtt"]);
        cmd.arg(&out_path);
        cmd.stdout(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| format!("ffmpeg spawn: {e}"))?;

        // Parked on the session before anything else can fail: this child is a
        // full read of a multi-gigabyte source, and one orphaned here would run
        // to completion unattached.
        let stdout = match child.stdout.take() {
            Some(stdout) => stdout,
            None => {
                reap(child);
                return Err("ffmpeg: no stdout".into());
            }
        };
        {
            let mut sessions = state.sessions.lock().unwrap();
            match sessions.get_mut(&session_id) {
                Some(s) => s.sub_child = Some(child),
                None => {
                    reap(child);
                    return Err("no such session".into());
                }
            }
        }

        // Reading to EOF is also how we wait for it: the pipe closes when ffmpeg
        // exits, and a killed child ends the loop instead of blocking forever.
        for line in std::io::BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if let Some(us) = line.strip_prefix("out_time_us=") {
                if let Ok(us) = us.trim().parse::<f64>() {
                    let mut sessions = state.sessions.lock().unwrap();
                    let Some(s) = sessions.get_mut(&session_id) else { break };
                    s.sub_progress_sec = us / 1_000_000.0;
                }
            }
        }

        // Taken out before waiting, so the lock is not held across it and a `None`
        // unambiguously means somebody else killed this run.
        let mut child = {
            let mut sessions = state.sessions.lock().unwrap();
            let s = sessions.get_mut(&session_id).ok_or("no such session")?;
            s.sub_progress_sec = 0.0;
            match s.sub_child.take() {
                Some(child) => child,
                None => return Err("cancelled".into()),
            }
        };
        let status = child.wait().map_err(|e| e.to_string())?;
        if !status.success() {
            let _ = std::fs::remove_file(&out_path);
            return Err(format!(
                "ffmpeg failed extracting subtitles ({})",
                status.code().unwrap_or(-1)
            ));
        }
        let text = std::fs::read_to_string(&out_path)
            .map_err(|e| format!("subtitle read: {e}"))?;
        let _ = std::fs::remove_file(&out_path);
        Ok(text)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Source seconds the in-flight subtitle extraction has scanned. Polled, because
/// nothing else in the app uses Tauri events and one long command is not reason
/// enough to add a push channel.
#[tauri::command]
pub async fn media_extract_progress(app: AppHandle, session_id: String) -> Result<f64, String> {
    let state = app.state::<MediaState>();
    let sessions = state.sessions.lock().unwrap();
    Ok(sessions
        .get(&session_id)
        .map(|s| s.sub_progress_sec)
        .unwrap_or(0.0))
}

#[tauri::command]
pub async fn media_close(app: AppHandle, session_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Dropping the session kills its ffmpeg and removes its cache dir.
        let removed = app
            .state::<MediaState>()
            .sessions
            .lock()
            .unwrap()
            .remove(&session_id);
        drop(removed);
    })
    .await
    .map_err(|e| e.to_string())
}

/// Clears anything a previous run left behind. An orphaned ffmpeg or a stale
/// multi-gigabyte cache directory is the most likely way this feature makes a
/// machine feel broken, so both ends are handled: this at startup, and
/// `shutdown` on exit.
pub fn cleanup_stale(app: &AppHandle) {
    if let Ok(cache) = app.path().app_cache_dir() {
        let _ = std::fs::remove_dir_all(cache.join("wp"));
    }
}

pub fn shutdown(app: &AppHandle) {
    let state = app.state::<MediaState>();
    let mut sessions = state.sessions.lock().unwrap();
    sessions.clear();
}

// ----------------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_the_shapes_we_generate() {
        assert_eq!(
            route("/s/abc/tok/src"),
            Route::Src { id: "abc".into(), token: "tok".into() }
        );
        assert_eq!(
            route("/s/abc/tok/w/3/index.m3u8"),
            Route::Playlist { id: "abc".into(), token: "tok".into(), generation: 3 }
        );
        assert_eq!(
            route("/s/abc/tok/w/3/00007.m4s"),
            Route::Segment {
                id: "abc".into(),
                token: "tok".into(),
                generation: 3,
                file: "00007.m4s".into(),
            }
        );
        assert_eq!(
            route("/s/abc/tok/w/0/init.mp4"),
            Route::Segment {
                id: "abc".into(),
                token: "tok".into(),
                generation: 0,
                file: "init.mp4".into(),
            }
        );
    }

    #[test]
    fn rejects_anything_else() {
        for path in [
            "/",
            "/s/abc/tok",
            "/s/abc/tok/other",
            "/s/abc/tok/w/x/index.m3u8",
            "/s/abc/tok/w/1/index.m3u8/extra",
            // Traversal cannot even be expressed: segment names are matched by
            // pattern, not sanitised.
            "/s/abc/tok/w/1/../../../secret",
            "/s/abc/tok/w/1/..%2Fsecret",
            // ffmpeg's in-progress rename target must never be servable.
            "/s/abc/tok/w/1/00001.m4s.tmp",
            "/s/abc/tok/w/1/ffmpeg.log",
            // Extracted cues are read by the command, never served.
            "/s/abc/tok/w/1/sub0.vtt",
        ] {
            assert_eq!(route(path), Route::NotFound, "{path}");
        }
    }

    #[test]
    fn segment_names_are_strict() {
        assert!(is_segment_name("init.mp4"));
        assert!(is_segment_name("00000.m4s"));
        assert!(!is_segment_name(".m4s"));
        assert!(!is_segment_name("a.m4s"));
        assert!(!is_segment_name("00000.m4s.tmp"));
        assert!(!is_segment_name("init.mp4.tmp"));
    }

    #[test]
    fn parses_byte_ranges() {
        assert_eq!(parse_range("bytes=0-99", 1000), Some((0, 99)));
        assert_eq!(parse_range("bytes=100-", 1000), Some((100, 999)));
        assert_eq!(parse_range("bytes=-100", 1000), Some((900, 999)));
        // Clamped to the end of the file rather than rejected.
        assert_eq!(parse_range("bytes=900-5000", 1000), Some((900, 999)));
    }

    #[test]
    fn declines_ranges_it_cannot_serve() {
        assert_eq!(parse_range("bytes=0-99, 200-299", 1000), None);
        assert_eq!(parse_range("bytes=1000-", 1000), None);
        assert_eq!(parse_range("bytes=abc", 1000), None);
        assert_eq!(parse_range("0-99", 1000), None);
        assert_eq!(parse_range("bytes=50-20", 1000), None);
        assert_eq!(parse_range("bytes=0-99", 0), None);
    }

    #[test]
    fn pins_playback_to_the_window_start() {
        let playlist = "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.0,\n00000.m4s\n";
        let out = rewrite_playlist(playlist);
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines[1], "#EXT-X-VERSION:7");
        assert_eq!(lines[2], "#EXT-X-START:TIME-OFFSET=0,PRECISE=YES");
        assert!(out.contains("00000.m4s"));
    }

    #[test]
    fn rewriting_is_idempotent() {
        // ffmpeg rewrites the playlist on every append and we re-inject per
        // request, so a second pass must not stack tags.
        let once = rewrite_playlist("#EXTM3U\n#EXT-X-VERSION:7\n");
        assert_eq!(rewrite_playlist(&once), once);
        assert_eq!(once.matches("#EXT-X-START").count(), 1);
    }

    #[test]
    fn injects_before_the_version_tag_exists() {
        // The very first playlist ffmpeg flushes can be just the header.
        let out = rewrite_playlist("#EXTM3U\n");
        assert!(out.contains("#EXT-X-START:TIME-OFFSET=0,PRECISE=YES"));
        assert!(out.contains("#EXTM3U"));
    }

    #[test]
    fn only_http_sources_are_accepted() {
        assert!(check_source("https://example.com/a.mkv").is_ok());
        assert!(check_source("http://example.com/a.mkv").is_ok());
        for bad in ["file:///etc/passwd", "/etc/passwd", "ftp://x/y", "data:,x"] {
            assert!(check_source(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn bitrate_tracks_frame_size() {
        let probe = |w: u64, h: u64| {
            serde_json::json!({"streams": [
                {"codec_type": "audio"},
                {"codec_type": "video", "width": w, "height": h}
            ]})
        };
        assert_eq!(target_bitrate_kbps(Some(&probe(1280, 720))), 3_000);
        assert_eq!(target_bitrate_kbps(Some(&probe(1920, 1080))), 6_000);
        assert_eq!(target_bitrate_kbps(Some(&probe(3840, 2160))), 16_000);
        // Unprobed or video-less input falls back to the 1080p budget.
        assert_eq!(target_bitrate_kbps(None), 6_000);
        assert_eq!(
            target_bitrate_kbps(Some(&serde_json::json!({"streams": []}))),
            6_000
        );
    }
}
