//! macOS system-audio capture for screen sharing.
//!
//! WKWebView does not expose display/system audio through getDisplayMedia, so
//! we tap it natively with ScreenCaptureKit and stream PCM to the frontend,
//! which feeds it into the WebRTC audio graph. `excludesCurrentProcessAudio`
//! keeps Haven's own output — i.e. the voices of the people on the call — out
//! of the capture, so sharing system audio during a call doesn't echo.
//!
//! Wire format to the frontend: base64 of interleaved stereo i16 LE at 48 kHz.

use tauri::ipc::Channel;

// `imp::start` blocks the calling thread for up to ~10s (two sequential
// recv_timeout(5s) waits on ScreenCaptureKit setup) — non-async Tauri
// commands run inline on the thread that dispatches the IPC call, so without
// spawn_blocking a slow/first-run-permission-prompt capture setup would
// freeze the whole window for that long.
#[tauri::command]
pub async fn sysaudio_start(channel: Channel<String>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(move || imp::start(channel))
            .await
            .map_err(|e| e.to_string())
            .and_then(|inner| inner)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = channel;
        Err("system audio capture is only implemented on macOS".into())
    }
}

#[tauri::command]
pub fn sysaudio_stop() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        imp::stop();
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
