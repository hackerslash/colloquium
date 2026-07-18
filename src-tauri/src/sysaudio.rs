//! Native system-audio capture for screen sharing (macOS + Windows).
//!
//! The WebView's own getDisplayMedia audio path is unusable for a call: macOS
//! WKWebView exposes no display audio at all, and on Windows getDisplayMedia
//! taps a whole-system loopback that recaptures Haven's own playback of the
//! other participants — sending their voices back to them (echo). So we tap
//! system audio natively and stream PCM to the frontend, which feeds it into
//! the WebRTC audio graph, **excluding Haven's own audio** so the call
//! doesn't echo:
//!   - macOS: ScreenCaptureKit, excluding Haven's application (incl. the
//!     WKWebView helper processes that actually render the call audio) from
//!     the content filter, plus `excludesCurrentProcessAudio`.
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
        tauri::async_runtime::spawn_blocking(move || {
            // Prefer CoreAudio process taps (macOS 14.4+): unlike the
            // ScreenCaptureKit app filter, taps can exclude the WKWebView GPU
            // helper that actually plays the call audio — SCK never enumerates
            // it (it owns no windows), so its playback leaked into the share
            // and echoed the participants back at themselves.
            match tap::start(channel.clone()) {
                Ok(()) => Ok(()),
                Err(e) => {
                    eprintln!("[sysaudio] CoreAudio tap unavailable ({e}); falling back to ScreenCaptureKit");
                    imp::start(channel)
                }
            }
        })
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
        tap::stop();
        imp::stop();
    }
    #[cfg(target_os = "windows")]
    {
        win::stop();
    }
    Ok(())
}

/// CoreAudio process-tap capture (macOS 14.4+). Captures ALL system audio
/// except an exclusion list we build ourselves: Haven's own process plus its
/// WKWebView helpers (which render the call audio). Identified three ways so
/// it works both bundled and in dev:
///   - pid == ours
///   - responsible pid == ours (bundled app: helpers belong to Haven.app)
///   - bundle starts with com.apple.WebKit AND shares our responsible pid
///     (dev: everything terminal-launched is "responsible to" the terminal,
///     so ours and our helpers share it; Safari's helpers don't)
#[cfg(target_os = "macos")]
mod tap {
    use std::ffi::c_void;
    use std::sync::Mutex;

    use base64::Engine as _;
    use objc2::rc::{Allocated, Retained};
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2::msg_send;
    use objc2_core_audio_types::{AudioBufferList, AudioStreamBasicDescription, AudioTimeStamp};
    use objc2_foundation::{NSArray, NSDictionary, NSNumber, NSString};
    use tauri::ipc::Channel;

    extern "C" {
        fn responsibility_get_pid_responsible_for_pid(pid: i32) -> i32;
    }

    type OSStatus = i32;
    type AudioObjectID = u32;

    #[repr(C)]
    struct AudioObjectPropertyAddress {
        selector: u32,
        scope: u32,
        element: u32,
    }

    const SYSTEM_OBJECT: AudioObjectID = 1;
    const SCOPE_GLOBAL: u32 = u32::from_be_bytes(*b"glob");
    const ELEMENT_MAIN: u32 = 0;
    const PROP_PROCESS_LIST: u32 = u32::from_be_bytes(*b"prs#");
    const PROP_PROCESS_PID: u32 = u32::from_be_bytes(*b"ppid");
    const PROP_PROCESS_BUNDLE: u32 = u32::from_be_bytes(*b"pbid");
    const PROP_TAP_FORMAT: u32 = u32::from_be_bytes(*b"tfmt");
    const PROP_NOMINAL_RATE: u32 = u32::from_be_bytes(*b"nsrt");

    type AudioDeviceIOProc = unsafe extern "C" fn(
        AudioObjectID,
        *const AudioTimeStamp,
        *const AudioBufferList,
        *const AudioTimeStamp,
        *mut AudioBufferList,
        *const AudioTimeStamp,
        *mut c_void,
    ) -> OSStatus;
    type AudioDeviceIOProcID = Option<AudioDeviceIOProc>;

    #[link(name = "CoreAudio", kind = "framework")]
    extern "C" {
        fn AudioObjectGetPropertyDataSize(
            object: AudioObjectID,
            address: *const AudioObjectPropertyAddress,
            qualifier_size: u32,
            qualifier: *const c_void,
            out_size: *mut u32,
        ) -> OSStatus;
        fn AudioObjectGetPropertyData(
            object: AudioObjectID,
            address: *const AudioObjectPropertyAddress,
            qualifier_size: u32,
            qualifier: *const c_void,
            io_size: *mut u32,
            out_data: *mut c_void,
        ) -> OSStatus;
        fn AudioObjectSetPropertyData(
            object: AudioObjectID,
            address: *const AudioObjectPropertyAddress,
            qualifier_size: u32,
            qualifier: *const c_void,
            size: u32,
            data: *const c_void,
        ) -> OSStatus;
        fn AudioHardwareCreateProcessTap(
            description: *mut AnyObject,
            out_tap: *mut AudioObjectID,
        ) -> OSStatus;
        fn AudioHardwareDestroyProcessTap(tap: AudioObjectID) -> OSStatus;
        fn AudioHardwareCreateAggregateDevice(
            description: *const c_void,
            out_device: *mut AudioObjectID,
        ) -> OSStatus;
        fn AudioHardwareDestroyAggregateDevice(device: AudioObjectID) -> OSStatus;
        fn AudioDeviceCreateIOProcID(
            device: AudioObjectID,
            io_proc: AudioDeviceIOProc,
            client_data: *mut c_void,
            out_id: *mut AudioDeviceIOProcID,
        ) -> OSStatus;
        fn AudioDeviceDestroyIOProcID(device: AudioObjectID, id: AudioDeviceIOProcID) -> OSStatus;
        fn AudioDeviceStart(device: AudioObjectID, id: AudioDeviceIOProcID) -> OSStatus;
        fn AudioDeviceStop(device: AudioObjectID, id: AudioDeviceIOProcID) -> OSStatus;
    }

    fn addr(selector: u32) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress {
            selector,
            scope: SCOPE_GLOBAL,
            element: ELEMENT_MAIN,
        }
    }

    fn list_audio_processes() -> Result<Vec<AudioObjectID>, String> {
        let address = addr(PROP_PROCESS_LIST);
        let mut size: u32 = 0;
        let status = unsafe {
            AudioObjectGetPropertyDataSize(
                SYSTEM_OBJECT,
                &address,
                0,
                core::ptr::null(),
                &mut size,
            )
        };
        if status != 0 {
            return Err(format!("process list size failed ({status})"));
        }
        let count = size as usize / core::mem::size_of::<AudioObjectID>();
        let mut ids = vec![0u32; count];
        let status = unsafe {
            AudioObjectGetPropertyData(
                SYSTEM_OBJECT,
                &address,
                0,
                core::ptr::null(),
                &mut size,
                ids.as_mut_ptr() as *mut c_void,
            )
        };
        if status != 0 {
            return Err(format!("process list failed ({status})"));
        }
        ids.truncate(size as usize / core::mem::size_of::<AudioObjectID>());
        Ok(ids)
    }

    fn pid_of(object: AudioObjectID) -> Option<i32> {
        let address = addr(PROP_PROCESS_PID);
        let mut pid: i32 = 0;
        let mut size = core::mem::size_of::<i32>() as u32;
        let status = unsafe {
            AudioObjectGetPropertyData(
                object,
                &address,
                0,
                core::ptr::null(),
                &mut size,
                &mut pid as *mut i32 as *mut c_void,
            )
        };
        (status == 0).then_some(pid)
    }

    fn bundle_of(object: AudioObjectID) -> String {
        let address = addr(PROP_PROCESS_BUNDLE);
        let mut string_ptr: *mut NSString = core::ptr::null_mut();
        let mut size = core::mem::size_of::<*mut NSString>() as u32;
        let status = unsafe {
            AudioObjectGetPropertyData(
                object,
                &address,
                0,
                core::ptr::null(),
                &mut size,
                &mut string_ptr as *mut *mut NSString as *mut c_void,
            )
        };
        if status != 0 || string_ptr.is_null() {
            return String::new();
        }
        // The property returns a +1 CFString; from_raw takes that ownership.
        unsafe { Retained::from_raw(string_ptr) }
            .map(|s| s.to_string())
            .unwrap_or_default()
    }

    /// Linear resampler for interleaved stereo f32 (tap rate -> 48 kHz).
    struct Resampler {
        ratio: f64,
        pos: f64,
    }

    impl Resampler {
        fn new(src_rate: f64) -> Self {
            Self {
                ratio: src_rate / 48_000.0,
                pos: 0.0,
            }
        }

        fn process(&mut self, input: &[f32]) -> Vec<f32> {
            let frames_in = input.len() / 2;
            if (self.ratio - 1.0).abs() < 1e-9 || frames_in == 0 {
                return input.to_vec();
            }
            let mut out = Vec::with_capacity(((frames_in as f64 / self.ratio) as usize + 2) * 2);
            let mut pos = self.pos;
            while pos < frames_in as f64 {
                let i = pos as usize;
                let frac = (pos - i as f64) as f32;
                let i1 = (i + 1).min(frames_in - 1);
                out.push(input[i * 2] + (input[i1 * 2] - input[i * 2]) * frac);
                out.push(input[i * 2 + 1] + (input[i1 * 2 + 1] - input[i * 2 + 1]) * frac);
                pos += self.ratio;
            }
            self.pos = pos - frames_in as f64;
            out
        }
    }

    struct TapCtx {
        channel: Channel<String>,
        resampler: Resampler,
    }

    unsafe extern "C" fn io_proc(
        _device: AudioObjectID,
        _now: *const AudioTimeStamp,
        input: *const AudioBufferList,
        _input_time: *const AudioTimeStamp,
        _output: *mut AudioBufferList,
        _output_time: *const AudioTimeStamp,
        client_data: *mut c_void,
    ) -> OSStatus {
        let ctx = &mut *(client_data as *mut TapCtx);
        let Some(abl) = input.as_ref() else { return 0 };
        let n = abl.mNumberBuffers as usize;
        if n == 0 {
            return 0;
        }
        let buffers = core::slice::from_raw_parts(abl.mBuffers.as_ptr(), n.min(2));
        let interleaved = super::pcm::interleave_stereo_f32(buffers);
        if interleaved.is_empty() {
            return 0;
        }
        let resampled = ctx.resampler.process(&interleaved);
        let out: Vec<i16> = resampled
            .iter()
            .map(|&s| (s.clamp(-1.0, 1.0) * 32767.0) as i16)
            .collect();
        let bytes: &[u8] =
            core::slice::from_raw_parts(out.as_ptr() as *const u8, out.len() * 2);
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
        let _ = ctx.channel.send(encoded);
        0
    }

    struct Capture {
        tap: AudioObjectID,
        aggregate: AudioObjectID,
        proc_id: AudioDeviceIOProcID,
        ctx: *mut TapCtx,
    }
    unsafe impl Send for Capture {}

    static STATE: Mutex<Option<Capture>> = Mutex::new(None);

    unsafe fn nsdict(
        keys: &[&NSString],
        values: &[&AnyObject],
    ) -> Retained<NSDictionary<NSString, AnyObject>> {
        msg_send![
            objc2::class!(NSDictionary),
            dictionaryWithObjects: values.as_ptr(),
            forKeys: keys.as_ptr() as *const *const NSString,
            count: keys.len(),
        ]
    }

    pub fn start(channel: Channel<String>) -> Result<(), String> {
        stop();

        let Some(tap_class) = AnyClass::get(c"CATapDescription") else {
            return Err("CATapDescription unavailable (needs macOS 14.4+)".into());
        };

        // Build the exclusion list from CoreAudio's own process objects.
        let our_pid = std::process::id() as i32;
        let our_responsible = unsafe { responsibility_get_pid_responsible_for_pid(our_pid) };
        let mut excluded: Vec<Retained<NSNumber>> = Vec::new();
        for object in list_audio_processes()? {
            let Some(pid) = pid_of(object) else { continue };
            let bundle = bundle_of(object);
            let responsible = unsafe { responsibility_get_pid_responsible_for_pid(pid) };
            let ours = pid == our_pid
                || responsible == our_pid
                || (bundle.starts_with("com.apple.WebKit")
                    && responsible > 0
                    && responsible == our_responsible);
            if ours || bundle.to_lowercase().contains("webkit") {
                eprintln!(
                    "[sysaudio] tap: audio process pid={pid} responsible={responsible} bundle={bundle} excluded={ours}"
                );
            }
            if ours {
                excluded.push(NSNumber::new_u32(object));
            }
        }
        eprintln!(
            "[sysaudio] tap: our pid={our_pid} responsible={our_responsible}; excluding {} audio processes",
            excluded.len()
        );

        let excluded_array = NSArray::from_retained_slice(&excluded);
        let description: Retained<AnyObject> = unsafe {
            let allocated: Allocated<AnyObject> = msg_send![tap_class, alloc];
            msg_send![allocated, initStereoGlobalTapButExcludeProcesses: &*excluded_array]
        };
        unsafe {
            let _: () = msg_send![&*description, setPrivate: true];
            let _: () = msg_send![&*description, setName: &*NSString::from_str("Haven screen-share audio")];
        }
        let tap_uuid: Retained<NSString> = unsafe {
            let uuid: Retained<AnyObject> = msg_send![&*description, UUID];
            msg_send![&*uuid, UUIDString]
        };

        let mut tap_id: AudioObjectID = 0;
        let status = unsafe {
            AudioHardwareCreateProcessTap(
                Retained::as_ptr(&description) as *mut AnyObject,
                &mut tap_id,
            )
        };
        if status != 0 {
            return Err(format!("AudioHardwareCreateProcessTap failed ({status})"));
        }

        // Aggregate device wrapping just the tap, so a standard device IOProc
        // can pull its audio.
        let aggregate_id = (|| -> Result<AudioObjectID, String> {
            let sub_tap = unsafe {
                nsdict(
                    &[&NSString::from_str("uid"), &NSString::from_str("drift")],
                    &[&*tap_uuid, &*NSNumber::new_i32(1)],
                )
            };
            let taps = NSArray::from_retained_slice(&[sub_tap]);
            let agg_uid = NSString::from_str("havenapp.sysaudio.aggregate");
            let agg_name = NSString::from_str("Haven sysaudio");
            let desc = unsafe {
                nsdict(
                    &[
                        &NSString::from_str("uid"),
                        &NSString::from_str("name"),
                        &NSString::from_str("private"),
                        &NSString::from_str("stacked"),
                        &NSString::from_str("taps"),
                    ],
                    &[
                        &*agg_uid,
                        &*agg_name,
                        &*NSNumber::new_i32(1),
                        &*NSNumber::new_i32(0),
                        &*taps,
                    ],
                )
            };
            let mut aggregate: AudioObjectID = 0;
            let status = unsafe {
                AudioHardwareCreateAggregateDevice(
                    Retained::as_ptr(&desc) as *const c_void,
                    &mut aggregate,
                )
            };
            if status != 0 {
                return Err(format!("AudioHardwareCreateAggregateDevice failed ({status})"));
            }
            Ok(aggregate)
        })()
        .inspect_err(|_| unsafe {
            AudioHardwareDestroyProcessTap(tap_id);
        })?;

        // Ask for 48 kHz; if the device won't take it, the resampler handles it.
        let wanted_rate: f64 = 48_000.0;
        let rate_address = addr(PROP_NOMINAL_RATE);
        unsafe {
            AudioObjectSetPropertyData(
                aggregate_id,
                &rate_address,
                0,
                core::ptr::null(),
                core::mem::size_of::<f64>() as u32,
                &wanted_rate as *const f64 as *const c_void,
            );
        }

        // Read the tap's actual stream format for the resampler.
        let mut asbd = AudioStreamBasicDescription {
            mSampleRate: 48_000.0,
            mFormatID: 0,
            mFormatFlags: 0,
            mBytesPerPacket: 0,
            mFramesPerPacket: 0,
            mBytesPerFrame: 0,
            mChannelsPerFrame: 2,
            mBitsPerChannel: 0,
            mReserved: 0,
        };
        let format_address = addr(PROP_TAP_FORMAT);
        let mut asbd_size = core::mem::size_of::<AudioStreamBasicDescription>() as u32;
        unsafe {
            AudioObjectGetPropertyData(
                tap_id,
                &format_address,
                0,
                core::ptr::null(),
                &mut asbd_size,
                &mut asbd as *mut AudioStreamBasicDescription as *mut c_void,
            );
        }
        eprintln!(
            "[sysaudio] tap: capturing at {} Hz, {} ch",
            asbd.mSampleRate, asbd.mChannelsPerFrame
        );

        let ctx = Box::into_raw(Box::new(TapCtx {
            channel,
            resampler: Resampler::new(if asbd.mSampleRate > 0.0 {
                asbd.mSampleRate
            } else {
                48_000.0
            }),
        }));

        let mut proc_id: AudioDeviceIOProcID = None;
        let status = unsafe {
            AudioDeviceCreateIOProcID(aggregate_id, io_proc, ctx as *mut c_void, &mut proc_id)
        };
        if status != 0 {
            unsafe {
                drop(Box::from_raw(ctx));
                AudioHardwareDestroyAggregateDevice(aggregate_id);
                AudioHardwareDestroyProcessTap(tap_id);
            }
            return Err(format!("AudioDeviceCreateIOProcID failed ({status})"));
        }
        let status = unsafe { AudioDeviceStart(aggregate_id, proc_id) };
        if status != 0 {
            unsafe {
                AudioDeviceDestroyIOProcID(aggregate_id, proc_id);
                drop(Box::from_raw(ctx));
                AudioHardwareDestroyAggregateDevice(aggregate_id);
                AudioHardwareDestroyProcessTap(tap_id);
            }
            return Err(format!("AudioDeviceStart failed ({status})"));
        }

        *STATE.lock().unwrap() = Some(Capture {
            tap: tap_id,
            aggregate: aggregate_id,
            proc_id,
            ctx,
        });
        Ok(())
    }

    pub fn stop() {
        let capture = STATE.lock().unwrap().take();
        if let Some(capture) = capture {
            unsafe {
                AudioDeviceStop(capture.aggregate, capture.proc_id);
                AudioDeviceDestroyIOProcID(capture.aggregate, capture.proc_id);
                AudioHardwareDestroyAggregateDevice(capture.aggregate);
                AudioHardwareDestroyProcessTap(capture.tap);
                drop(Box::from_raw(capture.ctx));
            }
        }
    }
}

/// Shared PCM helpers for the macOS capture paths.
#[cfg(target_os = "macos")]
mod pcm {
    use objc2_core_audio_types::AudioBuffer;

    /// Converts an AudioBufferList's buffers (f32, interleaved stereo OR two
    /// mono planes OR mono) into interleaved stereo f32.
    pub fn interleave_stereo_f32(buffers: &[AudioBuffer]) -> Vec<f32> {
        if buffers.len() >= 2 {
            let left = f32_slice(&buffers[0]);
            let right = f32_slice(&buffers[1]);
            let frames = left.len().min(right.len());
            let mut out = Vec::with_capacity(frames * 2);
            for i in 0..frames {
                out.push(left[i]);
                out.push(right[i]);
            }
            out
        } else {
            let buf = &buffers[0];
            let data = f32_slice(buf);
            let ch = buf.mNumberChannels.max(1) as usize;
            if ch >= 2 {
                data[..data.len() - data.len() % 2].to_vec()
            } else {
                let mut out = Vec::with_capacity(data.len() * 2);
                for &s in data {
                    out.push(s);
                    out.push(s);
                }
                out
            }
        }
    }

    pub fn f32_slice(buf: &AudioBuffer) -> &[f32] {
        if buf.mData.is_null() {
            return &[];
        }
        let len = buf.mDataByteSize as usize / core::mem::size_of::<f32>();
        unsafe { core::slice::from_raw_parts(buf.mData as *const f32, len) }
    }
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
        SCContentFilter, SCRunningApplication, SCShareableContent, SCStream,
        SCStreamConfiguration, SCStreamDelegate, SCStreamOutput, SCStreamOutputType, SCWindow,
    };
    use tauri::ipc::Channel;

    // WKWebView renders the call's audio in a separate helper process
    // (com.apple.WebKit.GPU), so `excludesCurrentProcessAudio` — which only
    // covers the capturing process itself — never excludes Haven's own
    // playback of the other participants, and their voices echo back through
    // the share. macOS attributes those helpers to the app that spawned them
    // via the "responsible process"; this (libquarantine, part of the
    // libSystem umbrella) resolves it so the app-level filter below can
    // exclude them too.
    extern "C" {
        fn responsibility_get_pid_responsible_for_pid(pid: i32) -> i32;
    }

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
            // Reserve room for up to 2 non-interleaved channel buffers. Backed
            // by u64 words so the buffer is 8-byte aligned for AudioBufferList
            // (a u8 Vec has alignment 1, which is UB to reinterpret as ABL).
            let base = core::mem::size_of::<AudioBufferList>();
            let extra = core::mem::size_of::<objc2_core_audio_types::AudioBuffer>();
            let total = base + extra;
            let mut storage = vec![0u64; total.div_ceil(8)];
            let abl = storage.as_mut_ptr() as *mut AudioBufferList;

            let mut block_buffer: *mut CMBlockBuffer = core::ptr::null_mut();
            let mut size_needed: usize = 0;
            let status = unsafe {
                sbuf.audio_buffer_list_with_retained_block_buffer(
                    &mut size_needed,
                    abl,
                    total,
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
    // Serializes the whole start/stop setup. `start` runs on a blocking thread
    // and its lengthy setup previously only took STATE at the end, so two
    // concurrent starts both built a capture and the second overwrote (and
    // leaked, still running) the first's SCStream.
    static SETUP: Mutex<()> = Mutex::new(());

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
        let _setup = SETUP.lock().unwrap_or_else(|e| e.into_inner());
        stop();

        let content = fetch_shareable_content()?;
        let displays = unsafe { content.displays() };
        let display = displays.firstObject().ok_or("no display to capture")?;

        // Exclude Haven at the APPLICATION level (audio filtering is
        // per-application), catching the WKWebView helper processes that
        // actually play the call audio — see the responsibility note above.
        let our_pid = std::process::id() as i32;
        let apps = unsafe { content.applications() };
        let own_apps: Vec<_> = apps
            .iter()
            .filter(|app| {
                let pid = unsafe { app.processID() };
                let resp = unsafe { responsibility_get_pid_responsible_for_pid(pid) };
                let bundle = unsafe { app.bundleIdentifier() }.to_string();
                let own = pid == our_pid || resp == our_pid;
                // Diagnostic: log every app that's ours or WebKit-related, so a
                // failing exclusion (echo) shows exactly what SCK enumerated.
                if own || bundle.to_lowercase().contains("webkit") {
                    eprintln!(
                        "[sysaudio] app pid={pid} responsible={resp} bundle={bundle} excluded={own}"
                    );
                }
                own
            })
            .collect();
        eprintln!(
            "[sysaudio] our pid={our_pid}; excluding {} of {} enumerated apps",
            own_apps.len(),
            apps.len()
        );
        if own_apps.is_empty() {
            eprintln!(
                "[sysaudio] WARNING: no own apps found to exclude — the call's own \
                 playback will be recaptured and participants will hear an echo"
            );
        }

        let filter = if own_apps.is_empty() {
            let empty = NSArray::new();
            unsafe {
                SCContentFilter::initWithDisplay_excludingWindows(
                    SCContentFilter::alloc(),
                    &display,
                    &empty,
                )
            }
        } else {
            let excluded = NSArray::<SCRunningApplication>::from_retained_slice(&own_apps);
            let no_windows = NSArray::<SCWindow>::new();
            unsafe {
                SCContentFilter::initWithDisplay_excludingApplications_exceptingWindows(
                    SCContentFilter::alloc(),
                    &display,
                    &excluded,
                    &no_windows,
                )
            }
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

        let queue = DispatchQueue::new("havenapp.sysaudio", DispatchQueueAttr::SERIAL);
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
    // Serializes start setup so two concurrent starts can't both spawn a capture
    // thread and have the second orphan the first (which would loop forever into
    // a dead channel, since its `running` flag is never cleared).
    static SETUP: Mutex<()> = Mutex::new(());

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

    /// Builds the loopback capture. COM must already be initialized on the
    /// calling thread; init/uninit are owned by `start`'s thread closure so the
    /// balance holds on every error path.
    fn setup() -> Result<Objects, String> {
        unsafe {
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
        let _setup = SETUP.lock().unwrap_or_else(|e| e.into_inner());
        stop();
        let running = Arc::new(AtomicBool::new(true));
        let running_thread = running.clone();
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();

        let join = std::thread::spawn(move || {
            // COM init/uninit are owned here (not in setup) so uninit is only
            // called after a successful init, and never before the COM
            // interfaces in `objects` are released.
            if let Err(e) = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok() } {
                let _ = ready_tx.send(Err(format!("CoInitializeEx failed: {e}")));
                return;
            }
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
            }
            drop(objects);
            unsafe { CoUninitialize() };
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
