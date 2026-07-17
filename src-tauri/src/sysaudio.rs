//! Native system-audio capture for screen sharing (macOS + Windows).
//!
//! The WebView's own getDisplayMedia audio path is unusable for a call: macOS
//! WKWebView exposes no display audio at all, and on Windows getDisplayMedia
//! taps a whole-system loopback that recaptures Haven's own playback of the
//! other participants — sending their voices back to them (echo). So we tap
//! system audio natively and stream PCM to the frontend, which feeds it into
//! the WebRTC audio graph, **excluding Haven's own process** so the call
//! doesn't echo:
//!   - macOS: ScreenCaptureKit with `excludesCurrentProcessAudio`.
//!   - Windows: WASAPI process loopback in EXCLUDE-target-process-tree mode.
//!
//! Wire format to the frontend: base64 of interleaved stereo i16 LE at 48 kHz.

use tauri::ipc::Channel;

// The platform `start` blocks the calling thread while the OS sets capture up
// (ScreenCaptureKit does two sequential 5s waits and can show a first-run
// permission prompt; WASAPI activation is async and waited on) — non-async
// Tauri commands run inline on the IPC dispatch thread, so without
// spawn_blocking a slow setup would freeze the whole window for that long.
#[tauri::command]
pub async fn sysaudio_start(channel: Channel<String>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(move || imp::start(channel))
            .await
            .map_err(|e| e.to_string())
            .and_then(|inner| inner)
    }
    #[cfg(target_os = "windows")]
    {
        tauri::async_runtime::spawn_blocking(move || win::start(channel))
            .await
            .map_err(|e| e.to_string())
            .and_then(|inner| inner)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = channel;
        Err("system audio capture is not implemented on this platform".into())
    }
}

#[tauri::command]
pub fn sysaudio_stop() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        imp::stop();
    }
    #[cfg(target_os = "windows")]
    {
        win::stop();
    }
    Ok(())
}

#[cfg(target_os = "macos")]
mod imp {
    use std::ptr::NonNull;
    use std::sync::mpsc;
    use std::sync::Mutex;
    use std::time::Duration;

    use base64::Engine as _;
    use block2::RcBlock;
    use dispatch2::{DispatchQueue, DispatchQueueAttr};
    use objc2::rc::Retained;
    use objc2::runtime::{NSObject, ProtocolObject};
    use objc2::{define_class, msg_send, AllocAnyThread, DefinedClass};
    use objc2_core_audio_types::AudioBufferList;
    use objc2_core_foundation::CFRetained;
    use objc2_core_media::{CMBlockBuffer, CMSampleBuffer};
    use objc2_foundation::{NSArray, NSError, NSObjectProtocol};
    use objc2_screen_capture_kit::{
        SCContentFilter, SCShareableContent, SCStream, SCStreamConfiguration, SCStreamDelegate,
        SCStreamOutput, SCStreamOutputType,
    };
    use tauri::ipc::Channel;

    const SAMPLE_RATE: isize = 48_000;
    const CHANNELS: isize = 2;

    struct Ivars {
        sender: Channel<String>,
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[name = "HavenSysAudioSink"]
        #[ivars = Ivars]
        struct AudioSink;

        unsafe impl NSObjectProtocol for AudioSink {}

        unsafe impl SCStreamDelegate for AudioSink {}

        unsafe impl SCStreamOutput for AudioSink {
            #[unsafe(method(stream:didOutputSampleBuffer:ofType:))]
            unsafe fn stream_did_output(
                &self,
                _stream: &SCStream,
                sample_buffer: &CMSampleBuffer,
                of_type: SCStreamOutputType,
            ) {
                if of_type != SCStreamOutputType::Audio {
                    return;
                }
                self.handle_audio(sample_buffer);
            }
        }
    );

    impl AudioSink {
        fn new(sender: Channel<String>) -> Retained<Self> {
            let this = Self::alloc().set_ivars(Ivars { sender });
            unsafe { msg_send![super(this), init] }
        }

        fn handle_audio(&self, sbuf: &CMSampleBuffer) {
            // Reserve room for up to 2 non-interleaved channel buffers.
            let base = core::mem::size_of::<AudioBufferList>();
            let extra = core::mem::size_of::<objc2_core_audio_types::AudioBuffer>();
            let mut storage = vec![0u8; base + extra];
            let abl = storage.as_mut_ptr() as *mut AudioBufferList;

            let mut block_buffer: *mut CMBlockBuffer = core::ptr::null_mut();
            let mut size_needed: usize = 0;
            let status = unsafe {
                sbuf.audio_buffer_list_with_retained_block_buffer(
                    &mut size_needed,
                    abl,
                    base + extra,
                    None,
                    None,
                    0,
                    &mut block_buffer,
                )
            };
            if status != 0 {
                return;
            }
            // Take ownership of the +1 block buffer so it's released on drop;
            // the sample data stays valid until then (we copy it below).
            let _bb = NonNull::new(block_buffer).map(|p| unsafe { CFRetained::from_raw(p) });

            let abl_ref = unsafe { &*abl };
            let n = abl_ref.mNumberBuffers as usize;
            if n == 0 {
                return;
            }
            let buffers =
                unsafe { core::slice::from_raw_parts(abl_ref.mBuffers.as_ptr(), n.min(2)) };

            let interleaved = pack_interleaved_i16(buffers);
            if interleaved.is_empty() {
                return;
            }

            let bytes: &[u8] = unsafe {
                core::slice::from_raw_parts(
                    interleaved.as_ptr() as *const u8,
                    interleaved.len() * 2,
                )
            };
            let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
            let _ = self.ivars().sender.send(encoded);
        }
    }

    /// Converts an AudioBufferList of Float32 PCM into interleaved stereo i16.
    /// Handles both non-interleaved (2 mono buffers) and interleaved (1 buffer,
    /// 2 channels) layouts, and up-mixes mono to stereo.
    fn pack_interleaved_i16(buffers: &[objc2_core_audio_types::AudioBuffer]) -> Vec<i16> {
        let to_i16 = |s: f32| -> i16 { (s.clamp(-1.0, 1.0) * 32767.0) as i16 };

        if buffers.len() >= 2 {
            let left = f32_slice(&buffers[0]);
            let right = f32_slice(&buffers[1]);
            let frames = left.len().min(right.len());
            let mut out = Vec::with_capacity(frames * 2);
            for i in 0..frames {
                out.push(to_i16(left[i]));
                out.push(to_i16(right[i]));
            }
            out
        } else {
            let buf = &buffers[0];
            let data = f32_slice(buf);
            let ch = buf.mNumberChannels.max(1) as usize;
            if ch >= 2 {
                // Truncate to a whole number of stereo frames — an odd sample
                // count would otherwise shift L/R for the rest of the buffer.
                data[..data.len() - data.len() % 2]
                    .iter()
                    .map(|&s| to_i16(s))
                    .collect()
            } else {
                // Mono -> duplicate to stereo.
                let mut out = Vec::with_capacity(data.len() * 2);
                for &s in data {
                    let v = to_i16(s);
                    out.push(v);
                    out.push(v);
                }
                out
            }
        }
    }

    fn f32_slice(buf: &objc2_core_audio_types::AudioBuffer) -> &[f32] {
        if buf.mData.is_null() {
            return &[];
        }
        let len = buf.mDataByteSize as usize / core::mem::size_of::<f32>();
        unsafe { core::slice::from_raw_parts(buf.mData as *const f32, len) }
    }

    // SCStream and its friends are usable across threads; the retained handles
    // aren't auto-Send, so we assert it for the stored capture state.
    struct Capture {
        stream: Retained<SCStream>,
        _sink: Retained<AudioSink>,
        _queue: dispatch2::DispatchRetained<DispatchQueue>,
    }
    unsafe impl Send for Capture {}

    static STATE: Mutex<Option<Capture>> = Mutex::new(None);

    fn fetch_shareable_content() -> Result<Retained<SCShareableContent>, String> {
        let (tx, rx) = mpsc::channel::<Result<Retained<SCShareableContent>, String>>();
        let handler = RcBlock::new(move |content: *mut SCShareableContent, err: *mut NSError| {
            match unsafe { Retained::retain(content) } {
                Some(c) => {
                    let _ = tx.send(Ok(c));
                }
                None => {
                    let msg = unsafe { err.as_ref() }
                        .map(|e| e.localizedDescription().to_string())
                        .unwrap_or_else(|| "no shareable content".to_string());
                    let _ = tx.send(Err(msg));
                }
            }
        });
        unsafe {
            SCShareableContent::getShareableContentWithCompletionHandler(&handler);
        }
        rx.recv_timeout(Duration::from_secs(5))
            .map_err(|_| "timed out enumerating shareable content".to_string())?
    }

    fn start_capture_blocking(stream: &SCStream) -> Result<(), String> {
        let (tx, rx) = mpsc::channel::<Result<(), String>>();
        let handler = RcBlock::new(move |err: *mut NSError| {
            let res = match unsafe { err.as_ref() } {
                Some(e) => Err(e.localizedDescription().to_string()),
                None => Ok(()),
            };
            let _ = tx.send(res);
        });
        unsafe {
            stream.startCaptureWithCompletionHandler(Some(&handler));
        }
        rx.recv_timeout(Duration::from_secs(5))
            .map_err(|_| "timed out starting capture".to_string())?
    }

    pub fn start(channel: Channel<String>) -> Result<(), String> {
        stop();

        let content = fetch_shareable_content()?;
        let displays = unsafe { content.displays() };
        let display = displays.firstObject().ok_or("no display to capture")?;

        let empty = NSArray::new();
        let filter = unsafe {
            SCContentFilter::initWithDisplay_excludingWindows(
                SCContentFilter::alloc(),
                &display,
                &empty,
            )
        };

        let config = unsafe { SCStreamConfiguration::new() };
        unsafe {
            config.setCapturesAudio(true);
            config.setExcludesCurrentProcessAudio(true);
            config.setSampleRate(SAMPLE_RATE);
            config.setChannelCount(CHANNELS);
            // We only consume audio; keep the mandatory video path tiny.
            config.setWidth(2);
            config.setHeight(2);
        }

        let sink = AudioSink::new(channel);
        let delegate: &ProtocolObject<dyn SCStreamDelegate> = ProtocolObject::from_ref(&*sink);
        let stream = unsafe {
            SCStream::initWithFilter_configuration_delegate(
                SCStream::alloc(),
                &filter,
                &config,
                Some(delegate),
            )
        };

        let queue = DispatchQueue::new("care.ayoo.haven.sysaudio", DispatchQueueAttr::SERIAL);
        let output: &ProtocolObject<dyn SCStreamOutput> = ProtocolObject::from_ref(&*sink);
        unsafe {
            stream.addStreamOutput_type_sampleHandlerQueue_error(
                output,
                SCStreamOutputType::Audio,
                Some(&queue),
            )
        }
        .map_err(|e| e.localizedDescription().to_string())?;

        start_capture_blocking(&stream)?;

        *STATE.lock().unwrap() = Some(Capture {
            stream,
            _sink: sink,
            _queue: queue,
        });
        Ok(())
    }

    pub fn stop() {
        // Drop the lock before the FFI call below — if it ever panicked while
        // held, STATE would be poisoned and system-audio capture permanently
        // unusable until restart.
        let cap = STATE.lock().unwrap().take();
        if let Some(cap) = cap {
            let handler = RcBlock::new(|_err: *mut NSError| {});
            unsafe {
                cap.stream.stopCaptureWithCompletionHandler(Some(&handler));
            }
        }
    }
}

#[cfg(target_os = "windows")]
mod win {
    //! WASAPI process-loopback capture that EXCLUDES Haven's own process tree,
    //! the Windows analog of macOS's `excludesCurrentProcessAudio`. Everything
    //! (COM init, activation, capture loop) runs on one dedicated thread so the
    //! non-Send COM interfaces never cross a thread boundary; `start` waits for
    //! setup to succeed/fail and returns that, then the thread polls until
    //! `stop` clears the run flag.

    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc, Arc, Condvar, Mutex};
    use std::thread::JoinHandle;
    use std::time::Duration;

    use base64::Engine as _;
    use tauri::ipc::Channel;

    use windows::core::{implement, Interface, IUnknown, HRESULT, PROPVARIANT};
    use windows::Win32::Media::Audio::{
        ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation,
        IActivateAudioInterfaceCompletionHandler,
        IActivateAudioInterfaceCompletionHandler_Impl, IAudioCaptureClient, IAudioClient,
        AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
        AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_PARAMS_0,
        AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS,
        PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE, VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
        WAVEFORMATEX,
    };
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};
    use windows::Win32::System::Threading::GetCurrentProcessId;

    const SAMPLE_RATE: u32 = 48_000;
    const CHANNELS: u16 = 2;
    const BITS: u16 = 16;
    const VT_BLOB: u16 = 65;
    // 200 ms buffer, in 100-ns units.
    const BUFFER_DURATION: i64 = 2_000_000;

    struct CaptureHandle {
        running: Arc<AtomicBool>,
        join: Option<JoinHandle<()>>,
    }

    static STATE: Mutex<Option<CaptureHandle>> = Mutex::new(None);

    /// Signals `ActivateCompleted` back to the waiting setup code without a
    /// Win32 event object (pure Rust, so no extra `windows` features needed).
    #[implement(IActivateAudioInterfaceCompletionHandler)]
    struct ActivateHandler {
        signal: Arc<(Mutex<bool>, Condvar)>,
    }

    impl IActivateAudioInterfaceCompletionHandler_Impl for ActivateHandler_Impl {
        fn ActivateCompleted(
            &self,
            _operation: Option<&IActivateAudioInterfaceAsyncOperation>,
        ) -> windows::core::Result<()> {
            let (lock, cv) = &*self.signal;
            *lock.lock().unwrap() = true;
            cv.notify_all();
            Ok(())
        }
    }

    /// PROPVARIANT holding a VT_BLOB. Built as an explicit repr(C) mirror of the
    /// real 64-bit layout (vt + 3 pad u16, then BLOB { u32 cbSize, ptr }) so we
    /// don't have to construct windows-rs's PROPVARIANT union by hand; we pass a
    /// pointer to it, which the callee reads by offset.
    #[repr(C)]
    struct BlobPropVariant {
        vt: u16,
        w1: u16,
        w2: u16,
        w3: u16,
        cb_size: u32,
        _pad: u32,
        p_blob_data: *mut core::ffi::c_void,
    }

    struct Objects {
        audio_client: IAudioClient,
        capture_client: IAudioCaptureClient,
    }

    fn setup() -> Result<Objects, String> {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED)
                .ok()
                .map_err(|e| format!("CoInitializeEx failed: {e}"))?;

            // Exclude our own process tree so the call's own audio (played by
            // Haven) is never recaptured — the whole point of the fix.
            let params = AUDIOCLIENT_ACTIVATION_PARAMS {
                ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
                Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
                    ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                        TargetProcessId: GetCurrentProcessId(),
                        ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
                    },
                },
            };
            let prop = BlobPropVariant {
                vt: VT_BLOB,
                w1: 0,
                w2: 0,
                w3: 0,
                cb_size: core::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
                _pad: 0,
                p_blob_data: &params as *const _ as *mut core::ffi::c_void,
            };
            let prop_ptr = &prop as *const BlobPropVariant as *const PROPVARIANT;

            let signal = Arc::new((Mutex::new(false), Condvar::new()));
            let handler: IActivateAudioInterfaceCompletionHandler = ActivateHandler {
                signal: signal.clone(),
            }
            .into();

            let op: IActivateAudioInterfaceAsyncOperation = ActivateAudioInterfaceAsync(
                VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
                &IAudioClient::IID,
                Some(prop_ptr),
                &handler,
            )
            .map_err(|e| format!("ActivateAudioInterfaceAsync failed: {e}"))?;

            // Wait for the async activation to complete (params/prop must stay
            // alive until then — they do, we're still in scope).
            {
                let (lock, cv) = &*signal;
                let mut done = lock.lock().unwrap();
                while !*done {
                    let (guard, timeout) = cv
                        .wait_timeout(done, Duration::from_secs(5))
                        .map_err(|_| "activation wait poisoned".to_string())?;
                    done = guard;
                    if timeout.timed_out() {
                        return Err("timed out activating audio interface".into());
                    }
                }
            }

            let mut activate_hr = HRESULT(0);
            let mut unknown: Option<IUnknown> = None;
            op.GetActivateResult(&mut activate_hr, &mut unknown)
                .map_err(|e| format!("GetActivateResult failed: {e}"))?;
            activate_hr
                .ok()
                .map_err(|e| format!("audio interface activation failed: {e}"))?;
            let audio_client: IAudioClient = unknown
                .ok_or("activation returned no interface")?
                .cast()
                .map_err(|e| format!("cast to IAudioClient failed: {e}"))?;

            let format = WAVEFORMATEX {
                wFormatTag: 1, // WAVE_FORMAT_PCM
                nChannels: CHANNELS,
                nSamplesPerSec: SAMPLE_RATE,
                nAvgBytesPerSec: SAMPLE_RATE * (CHANNELS as u32) * (BITS as u32 / 8),
                nBlockAlign: CHANNELS * (BITS / 8),
                wBitsPerSample: BITS,
                cbSize: 0,
            };

            audio_client
                .Initialize(
                    AUDCLNT_SHAREMODE_SHARED,
                    AUDCLNT_STREAMFLAGS_LOOPBACK,
                    BUFFER_DURATION,
                    0,
                    &format,
                    None,
                )
                .map_err(|e| format!("IAudioClient::Initialize failed: {e}"))?;

            let capture_client: IAudioCaptureClient = audio_client
                .GetService()
                .map_err(|e| format!("GetService(IAudioCaptureClient) failed: {e}"))?;

            audio_client
                .Start()
                .map_err(|e| format!("IAudioClient::Start failed: {e}"))?;

            Ok(Objects {
                audio_client,
                capture_client,
            })
        }
    }

    fn capture_loop(objects: &Objects, channel: &Channel<String>, running: &AtomicBool) {
        let silent_flag = AUDCLNT_BUFFERFLAGS_SILENT.0 as u32;
        while running.load(Ordering::Relaxed) {
            unsafe {
                let mut packet = match objects.capture_client.GetNextPacketSize() {
                    Ok(n) => n,
                    Err(_) => break,
                };
                if packet == 0 {
                    std::thread::sleep(Duration::from_millis(8));
                    continue;
                }
                while packet != 0 {
                    let mut data: *mut u8 = core::ptr::null_mut();
                    let mut frames: u32 = 0;
                    let mut flags: u32 = 0;
                    if objects
                        .capture_client
                        .GetBuffer(&mut data, &mut frames, &mut flags, None, None)
                        .is_err()
                    {
                        return;
                    }
                    if frames > 0 && (flags & silent_flag) == 0 && !data.is_null() {
                        // Already interleaved stereo i16 LE at 48 kHz — the exact
                        // wire format the frontend worklet expects.
                        let byte_len = frames as usize * (CHANNELS as usize) * 2;
                        let bytes = core::slice::from_raw_parts(data, byte_len);
                        let encoded =
                            base64::engine::general_purpose::STANDARD.encode(bytes);
                        let _ = channel.send(encoded);
                    }
                    if objects.capture_client.ReleaseBuffer(frames).is_err() {
                        return;
                    }
                    packet = match objects.capture_client.GetNextPacketSize() {
                        Ok(n) => n,
                        Err(_) => return,
                    };
                }
            }
        }
    }

    pub fn start(channel: Channel<String>) -> Result<(), String> {
        stop();
        let running = Arc::new(AtomicBool::new(true));
        let running_thread = running.clone();
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();

        let join = std::thread::spawn(move || {
            let objects = match setup() {
                Ok(o) => o,
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                    unsafe { CoUninitialize() };
                    return;
                }
            };
            let _ = ready_tx.send(Ok(()));
            capture_loop(&objects, &channel, &running_thread);
            unsafe {
                let _ = objects.audio_client.Stop();
                CoUninitialize();
            }
        });

        match ready_rx.recv_timeout(Duration::from_secs(6)) {
            Ok(Ok(())) => {
                *STATE.lock().unwrap() = Some(CaptureHandle {
                    running,
                    join: Some(join),
                });
                Ok(())
            }
            Ok(Err(e)) => {
                running.store(false, Ordering::Relaxed);
                let _ = join.join();
                Err(e)
            }
            Err(_) => {
                running.store(false, Ordering::Relaxed);
                let _ = join.join();
                Err("timed out starting system-audio capture".into())
            }
        }
    }

    pub fn stop() {
        let handle = STATE.lock().unwrap().take();
        if let Some(mut handle) = handle {
            handle.running.store(false, Ordering::Relaxed);
            if let Some(join) = handle.join.take() {
                let _ = join.join();
            }
        }
    }
}
