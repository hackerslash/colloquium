import type { Identity } from "../../types/domain";
import type {
  CallAcceptMessage,
  CallDeclineMessage,
  CallHangupMessage,
  CallInviteMessage,
  CallMediaStateMessage,
  CallRingingMessage,
  RtcCandidateMessage,
  RtcDescriptionMessage,
} from "../../types/wire";
import { getOutbox, getPeerRegistry } from "../peer/registry";
import { derivePeerId } from "../peer/derivePeerId";
import { PeerConnectionWrapper } from "./PeerConnectionWrapper";
import { SpeakingMonitor } from "./speakingMonitor";
import {
  captureDisplay,
  describeScreenShareError,
  logScreenShare,
  releaseDisplayAudio,
  type DisplayCapture,
  type ScreenStopSource,
} from "./displayMedia";
import { applyMicProcessing, buildMicConstraints, markVoiceTracks } from "./micAudio";
import { createMicProcessor, type MicProcessor } from "./noiseSuppressor";
import { resolveScreenTierSpec, type ScreenShareQualityOption } from "./screenShareConfig";
import { emitCallEvent } from "./callEvents";
import { logCallDebug, trackDebugInfo } from "./callDebug";
import { useCallStore } from "../../stores/useCallStore";
import { useRoomCallStore } from "../../stores/useRoomCallStore";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { notifyIfUnfocused } from "../notify";
import { toast } from "../../stores/useToastStore";

function buildVideoConstraints(): MediaTrackConstraints {
  const { videoInputDeviceId } = useSettingsStore.getState();
  return {
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    frameRate: { ideal: 30 },
    ...(videoInputDeviceId ? { deviceId: { exact: videoInputDeviceId } } : {}),
  };
}

/** Ring timeout on both sides. */
const RING_TIMEOUT_MS = 30_000;
/** How long an undeliverable invite waits in the Outbox before the call is
 * abandoned as unreachable. Pinned to RING_TIMEOUT_MS (not a shorter, separate
 * constant) so it's never accidentally shorter than the broker's own
 * reconnect backoff ceiling — otherwise a call placed during a broker blip
 * gets abandoned as unreachable moments before the broker would have
 * recovered. There's also no reason to give up on delivery before we'd give
 * up on ringing anyway. */
const INVITE_TTL_MS = RING_TIMEOUT_MS;
/** How long a call may sit disconnected/failed (ICE restarts still trying)
 * before we declare the peer gone — crashed apps never say goodbye, so
 * without this the call shows "Reconnecting…" forever. */
const CALL_DROP_TIMEOUT_MS = 20_000;

type CallContext = {
  self: Identity;
  remoteId: string;
  roomId: string;
  inviteId: string;
  wrapper: PeerConnectionWrapper | null;
  localStream: MediaStream | null;
  screenStream: MediaStream | null;
  /** Remote tracks re-grouped by their wire (msid) stream: mic+camera vs
   * screen. A single <video> plays only a stream's FIRST video track, so if
   * screen shared a stream with the camera it would never render. */
  remoteMainStream: MediaStream;
  remoteScreenStream: MediaStream;
  /** msid of the remote's mic+camera stream — the first stream to arrive
   * (both sides attach the mic before any video); any other msid is screen. */
  remoteMainStreamId: string | null;
  ringTimer: ReturnType<typeof setTimeout> | null;
  dropTimer: ReturnType<typeof setTimeout> | null;
  speakingMonitor: SpeakingMonitor | null;
  /** RNNoise processor wrapping the raw mic; null if unavailable (we then
   * transmit the raw mic track). */
  micProcessor: MicProcessor | null;
};

let ctx: CallContext | null = null;
/** Callee-side ring state (before any ctx exists). */
let incomingTimer: ReturnType<typeof setTimeout> | null = null;

function sendToRemote(remoteId: string, data: unknown) {
  getPeerRegistry().send(derivePeerId(remoteId), data);
}

/** Announces our camera/screen state so the remote drops its frozen last
 * frame immediately — WebKit receivers don't reliably fire `mute` when our
 * sender replaceTrack(null)s. */
function sendMediaState() {
  if (!ctx) return;
  const store = useCallStore.getState();
  sendToRemote(ctx.remoteId, {
    type: "call_media_state",
    roomId: ctx.roomId,
    fromId: ctx.self.identityId,
    camOn: store.camOn,
    screenOn: store.screenOn,
  } satisfies CallMediaStateMessage);
}

function clearIncomingTimer() {
  if (incomingTimer) clearTimeout(incomingTimer);
  incomingTimer = null;
}

function clearDropTimer() {
  if (ctx?.dropTimer) {
    clearTimeout(ctx.dropTimer);
    ctx.dropTimer = null;
  }
}

async function acquireLocalMedia(withVideo: boolean): Promise<MediaStream> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: buildMicConstraints(),
      video: withVideo ? buildVideoConstraints() : false,
    });
  } catch {
    // Fall back to audio-only if the camera is unavailable/denied.
    stream = await navigator.mediaDevices.getUserMedia({ audio: buildMicConstraints() });
  }
  markVoiceTracks(stream);
  return stream;
}

/** Builds the RNNoise processor around the current raw mic. Best-effort — on
 * failure ctx.micProcessor stays null and we transmit the raw mic track. */
async function initMicProcessing(): Promise<void> {
  if (!ctx?.localStream) return;
  const rawAudio = ctx.localStream.getAudioTracks()[0];
  if (!rawAudio) return;
  const enabled = useSettingsStore.getState().noiseSuppression;
  const call = ctx;
  const processor = await createMicProcessor(rawAudio, enabled);
  // The call may have ended while the wasm/worklet loaded — don't leak the
  // AudioContext into a dead call.
  if (ctx !== call) {
    void processor?.dispose();
    return;
  }
  call.micProcessor = processor;
  if (processor) {
    processor.track.enabled = useCallStore.getState().micOn;
    rawAudio.enabled = true;
  }
}

/** The audio track we transmit: the RNNoise-processed track when available,
 * otherwise the raw mic. */
function outgoingAudioTrack(): MediaStreamTrack | null {
  return ctx?.micProcessor?.track ?? ctx?.localStream?.getAudioTracks()[0] ?? null;
}

/** Re-applies the current voice settings to the live mic. Called by the
 * settings store when the user toggles noise suppression. */
export async function applyMicSettings(): Promise<void> {
  ctx?.micProcessor?.setEnabled(useSettingsStore.getState().noiseSuppression);
  await applyMicProcessing(ctx?.localStream);
}

/** Watches a freshly-acquired mic: WebKit can hand back a track whose capture
 * unit then fails to start (goes `muted` shortly after) when a unit was torn
 * down moments earlier — the echo-cancellation toggle's same-device
 * re-acquire. Logs the state and re-acquires once if the track is dead. */
function watchMicHealth(track: MediaStreamTrack, wasRecovery: boolean) {
  const call = ctx;
  track.onmute = () => logCallDebug("mic-health:muted", trackDebugInfo(track));
  track.onunmute = () => logCallDebug("mic-health:unmuted", trackDebugInfo(track));
  const check = (label: string) => {
    if (ctx !== call || !call) return;
    if (call.localStream?.getAudioTracks()[0] !== track) return;
    logCallDebug(`mic-health:${label}`, trackDebugInfo(track));
    if (!wasRecovery && (track.muted || track.readyState === "ended")) {
      logCallDebug("mic-health:re-acquiring", {});
      void switchMicDevice(true);
    }
  };
  setTimeout(() => check("check-1s"), 1_000);
  setTimeout(() => check("check-3s"), 3_000);
}

let micSwitchInFlight = false;

/** Switches the live microphone to the device currently selected in settings.
 * Replaces the audio track on the peer connection sender and restarts the
 * speaking monitor so it analyses the new input stream. No-op when not in a
 * call or when the mic cannot be re-acquired. */
export async function switchMicDevice(isRecovery = false): Promise<void> {
  if (micSwitchInFlight) return;
  micSwitchInFlight = true;
  try {
    await switchMicDeviceInner(isRecovery);
  } finally {
    micSwitchInFlight = false;
  }
}

async function switchMicDeviceInner(isRecovery: boolean): Promise<void> {
  const call = ctx;
  if (!call) return;
  // Captured before the processor swap: identifies the exact sender carrying
  // the mic, so the replace can never land on a screen-share audio sender.
  const previousOutgoing = outgoingAudioTrack();
  logCallDebug("mic-switch:begin", {
    oldRaw: trackDebugInfo(call.localStream?.getAudioTracks()[0]),
    oldOutgoing: trackDebugInfo(previousOutgoing),
    micOn: useCallStore.getState().micOn,
  });
  // Same-device re-acquire (the echo-cancellation toggle): WebKit shares one
  // capture unit per device, so the old track must be released BEFORE asking
  // for one with different processing — acquiring first hands back a track
  // tied to the old unit, and stopping the old track then kills both (dead
  // mic until rejoin).
  const oldRaw = call.localStream?.getAudioTracks()[0];
  const targetDevice = useSettingsStore.getState().audioInputDeviceId;
  if (oldRaw && (!targetDevice || oldRaw.getSettings().deviceId === targetDevice)) {
    call.localStream?.removeTrack(oldRaw);
    oldRaw.stop();
    // Give the unit teardown a beat — an immediate same-device re-open can
    // hand back a track whose capture unit never starts (silent mic).
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (ctx !== call) return;
  }
  let newStream: MediaStream;
  try {
    newStream = await navigator.mediaDevices.getUserMedia({ audio: buildMicConstraints() });
  } catch (err) {
    console.warn("switchMicDevice: getUserMedia failed", err);
    return;
  }
  if (ctx !== call) {
    // Call ended while the permission prompt was open.
    newStream.getTracks().forEach((t) => t.stop());
    return;
  }
  markVoiceTracks(newStream);
  const newTrack = newStream.getAudioTracks()[0];
  if (!newTrack) {
    newStream.getTracks().forEach((t) => t.stop());
    return;
  }

  // Release the old mic NOW, not after the swap: two simultaneously-open
  // echo-cancelled captures make macOS rebuild its voice-processing unit
  // across both devices, audibly changing how the remote's playback sounds.
  for (const old of call.localStream?.getAudioTracks() ?? []) {
    call.localStream?.removeTrack(old);
    old.stop();
  }

  // Rebuild RNNoise around the new mic and transmit the processed track (raw
  // fallback), so noise suppression survives a device change instead of the
  // sender reverting to the unprocessed mic.
  const oldProcessor = call.micProcessor;
  const newProcessor = await createMicProcessor(
    newTrack,
    useSettingsStore.getState().noiseSuppression,
  );
  if (ctx !== call) {
    void newProcessor?.dispose();
    newStream.getTracks().forEach((t) => t.stop());
    return;
  }
  call.micProcessor = newProcessor;
  const outgoing = newProcessor?.track ?? newTrack;
  // Preserve mute state across the swap so switching device doesn't unmute.
  outgoing.enabled = useCallStore.getState().micOn;

  // Replace the mic sender's track on the peer connection. Match the previous
  // outgoing track exactly; fall back to any audio sender that isn't carrying
  // screen-share (system) audio.
  const senders = call.wrapper?.pc.getSenders() ?? [];
  const screenAudio = new Set(call.screenStream?.getAudioTracks() ?? []);
  const sender =
    senders.find((s) => s.track !== null && s.track === previousOutgoing) ??
    senders.find((s) => s.track?.kind === "audio" && !screenAudio.has(s.track));
  if (sender) {
    try {
      await sender.replaceTrack(outgoing);
    } catch (err) {
      console.warn("switchMicDevice: replaceTrack failed", err);
    }
  }
  if (ctx !== call) {
    void newProcessor?.dispose();
    newStream.getTracks().forEach((t) => t.stop());
    return;
  }

  // The old processor's processed track is no longer sent — tear it down.
  void oldProcessor?.dispose();

  if (!call.localStream) call.localStream = new MediaStream();
  call.localStream.addTrack(newTrack);

  // Restart the speaking monitor on the new stream.
  if (call.speakingMonitor) {
    call.speakingMonitor.stop();
    call.speakingMonitor = null;
  }
  startSpeakingMonitor();
  logCallDebug("mic-switch:done", {
    newRaw: trackDebugInfo(newTrack),
    outgoing: trackDebugInfo(outgoing),
    rnnoise: newProcessor !== null,
  });
  watchMicHealth(newTrack, isRecovery);
}

/** Re-opens the camera with the device currently selected in settings and
 * replaces the existing video track on all peer connection senders. No-op
 * when the camera is not currently on or there is no active call. */
export async function switchCameraDevice(): Promise<void> {
  const call = ctx;
  if (!call) return;
  const store = useCallStore.getState();
  if (!store.camOn) return; // camera is off — nothing to switch

  let cameraStream: MediaStream;
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: buildVideoConstraints() });
  } catch (err) {
    console.warn("switchCameraDevice: getUserMedia failed", err);
    return;
  }
  if (ctx !== call) {
    cameraStream.getTracks().forEach((t) => t.stop());
    return;
  }
  const newTrack = cameraStream.getVideoTracks()[0];
  if (!newTrack) {
    cameraStream.getTracks().forEach((t) => t.stop());
    return;
  }

  // Stop old camera track.
  const oldTrack = call.localStream?.getVideoTracks()[0];
  if (oldTrack) {
    call.localStream?.removeTrack(oldTrack);
    oldTrack.stop();
  }
  if (!call.localStream) call.localStream = new MediaStream();
  call.localStream.addTrack(newTrack);

  if (call.wrapper) {
    await call.wrapper.replaceVideoTrack(newTrack, "camera");
  }
  if (ctx !== call) {
    newTrack.stop();
  }
}

/** Routes a remote track into the main (mic+camera) or screen stream by msid
 * and pushes both to the store. Re-fired on mute/unmute/ended so the UI can
 * react to a share stopping (replaceTrack(null) far-side mutes the track). */
function routeRemoteTrack(
  remoteId: string,
  track: MediaStreamTrack,
  streams: readonly MediaStream[],
) {
  const call = ctx;
  if (!call || call.remoteId !== remoteId) return;
  const streamId = streams[0]?.id ?? "";
  if (call.remoteMainStreamId === null) call.remoteMainStreamId = streamId;
  const target =
    streamId === call.remoteMainStreamId ? call.remoteMainStream : call.remoteScreenStream;
  if (track.readyState === "ended") target.removeTrack(track);
  else if (!target.getTracks().includes(track)) target.addTrack(track);
  const store = useCallStore.getState();
  store._setRemoteStream(call.remoteMainStream);
  store._setRemoteScreenStream(
    call.remoteScreenStream.getTracks().length > 0 ? call.remoteScreenStream : null,
  );
}

function buildWrapper(self: Identity, remoteId: string): PeerConnectionWrapper {
  // Lexicographically-greater identityId is the polite peer — both ends
  // compute this identically, no coordination needed.
  const isPolite = self.identityId > remoteId;
  return new PeerConnectionWrapper(isPolite, {
    onDescription: (description) =>
      sendToRemote(remoteId, {
        type: "rtc_description",
        channel: "dm",
        fromId: self.identityId,
        description,
      } satisfies RtcDescriptionMessage),
    onCandidate: (candidate) =>
      sendToRemote(remoteId, {
        type: "rtc_candidate",
        channel: "dm",
        fromId: self.identityId,
        candidate,
      } satisfies RtcCandidateMessage),
    onTrack: (track, streams) => routeRemoteTrack(remoteId, track, streams),
    onQuality: (quality) => useCallStore.getState()._setQuality(quality),
    onScreenBitrate: (bps) => useCallStore.getState()._setScreenLinkBps(bps),
    onConnectionStateChange: (state) => {
      useCallStore.getState()._setConnectionState(state);
      if (state === "connected") useCallStore.getState()._setStatus("active");
      // Don't hang up on "disconnected"/"failed" immediately — the wrapper's
      // ICE-restart layer tries to recover and the UI shows a reconnecting
      // state. But a crashed peer never sends a hangup, so if the outage
      // outlives the drop timeout, declare the call lost and end it.
      if (state === "connected") {
        clearDropTimer();
      } else if ((state === "disconnected" || state === "failed") && ctx && !ctx.dropTimer) {
        ctx.dropTimer = setTimeout(() => {
          if (!ctx) return;
          const lostRemoteId = ctx.remoteId;
          endCallLocal();
          emitCallEvent({ kind: "call-lost", remoteId: lostRemoteId });
        }, CALL_DROP_TIMEOUT_MS);
      }
      if (state === "closed" && ctx) endCallLocal();
    },
  });
}

function attachLocalTracks() {
  if (!ctx?.wrapper || !ctx.localStream) return;
  // Transmit the RNNoise-processed track (falls back to the raw mic). The raw
  // stream is still the msid group so the receiver pairs audio with the camera.
  const audioTrack = outgoingAudioTrack();
  if (audioTrack) ctx.wrapper.addTrack(audioTrack, ctx.localStream);
  for (const track of ctx.localStream.getVideoTracks()) {
    ctx.wrapper.addVideoTrack(track, ctx.localStream, "camera");
  }
}

function startSpeakingMonitor() {
  if (!ctx || ctx.speakingMonitor) return;
  const remoteId = ctx.remoteId;
  const selfId = ctx.self.identityId;
  const monitor = new SpeakingMonitor(
    ctx.self.identityId,
    ctx.localStream,
    () => {
      const receivers = new Map<string, RTCRtpReceiver[]>();
      if (!ctx?.wrapper) return receivers;
      const audioReceivers = ctx.wrapper.pc
        .getReceivers()
        .filter((r) => r.track && r.track.kind === "audio");
      if (audioReceivers.length > 0) receivers.set(remoteId, audioReceivers);
      return receivers;
    },
    (ids) => {
      const store = useCallStore.getState();
      // The raw capture stays hot while muted (see setMic) — don't show
      // ourselves as speaking off what isn't transmitted.
      store._setSpeaking(store.micOn ? ids : new Set([...ids].filter((id) => id !== selfId)));
    },
  );
  monitor.start();
  ctx.speakingMonitor = monitor;
}

export async function startCall(self: Identity, roomId: string, remoteId: string, withVideo: boolean) {
  if (ctx) return;
  if (useRoomCallStore.getState().roomId !== null) {
    emitCallEvent({ kind: "call-blocked-in-room-call" });
    return;
  }

  const localStream = await acquireLocalMedia(withVideo);
  // Re-validate after the mic/camera prompt: an incoming invite, a room call,
  // or a second startCall may have claimed the call slot while we awaited.
  // Without this the two paths clobber each other's state and both sides wedge.
  if (ctx || useCallStore.getState().activeCall || useRoomCallStore.getState().roomId !== null) {
    localStream.getTracks().forEach((t) => t.stop());
    return;
  }
  const inviteId = crypto.randomUUID();
  ctx = {
    self,
    remoteId,
    roomId,
    inviteId,
    wrapper: null,
    localStream,
    screenStream: null,
    remoteMainStream: new MediaStream(),
    remoteScreenStream: new MediaStream(),
    remoteMainStreamId: null,
    ringTimer: null,
    dropTimer: null,
    speakingMonitor: null,
    micProcessor: null,
  };
  await initMicProcessing();

  const registry = getPeerRegistry();
  const store = useCallStore.getState();
  const reachableNow = registry.isConnected(derivePeerId(remoteId));
  store._setActiveCall({
    roomId,
    remoteId,
    status: reachableNow ? "outgoing" : "dialing",
    withVideo,
  });
  store._setLocalStream(localStream);
  store._setMediaFlags(true, withVideo && localStream.getVideoTracks().length > 0);

  const invite: CallInviteMessage = {
    type: "call_invite",
    roomId,
    fromId: self.identityId,
    inviteId,
    withVideo,
  };
  getOutbox().send(derivePeerId(remoteId), invite, INVITE_TTL_MS, () => {
    // Never delivered within the TTL — give up cleanly.
    if (ctx?.inviteId !== inviteId) return;
    endCallLocal();
    emitCallEvent({ kind: "call-unreachable", remoteId });
  });

  ctx.ringTimer = setTimeout(() => {
    if (ctx?.inviteId !== inviteId) return;
    sendToRemote(remoteId, {
      type: "call_hangup",
      roomId,
      fromId: self.identityId,
      reason: "timeout",
    } satisfies CallHangupMessage);
    endCallLocal();
    emitCallEvent({ kind: "call-no-answer", remoteId });
  }, RING_TIMEOUT_MS);
}

export async function acceptCall(self: Identity) {
  const store = useCallStore.getState();
  const active = store.activeCall;
  if (!active || active.status !== "incoming") return;
  clearIncomingTimer();
  const inviteId = active.inviteId;

  // Voice calls stay voice: the camera only opens when the caller asked for
  // video. Either side can still turn their camera on later.
  let localStream: MediaStream;
  try {
    localStream = await acquireLocalMedia(active.withVideo);
  } catch (err) {
    // Mic unavailable/denied — let the caller know we're not answering
    // instead of leaving them ringing forever, and clear our own UI so the
    // incoming-call banner doesn't get stuck.
    sendToRemote(active.remoteId, {
      type: "call_decline",
      roomId: active.roomId,
      fromId: self.identityId,
      inviteId: active.inviteId,
      reason: "declined",
    } satisfies CallDeclineMessage);
    useCallStore.getState()._clear();
    throw err;
  }

  // The call may have already ended (remote hangup/decline, or another path
  // raced ahead) while the permission prompt was open — don't resurrect a
  // dead call with a freshly-opened mic/camera the remote will never see.
  const stillActive = useCallStore.getState().activeCall;
  if (ctx || !stillActive || stillActive.status !== "incoming" || stillActive.inviteId !== inviteId) {
    localStream.getTracks().forEach((t) => t.stop());
    return;
  }

  ctx = {
    self,
    remoteId: active.remoteId,
    roomId: active.roomId,
    inviteId: active.inviteId ?? crypto.randomUUID(),
    wrapper: null,
    localStream,
    screenStream: null,
    remoteMainStream: new MediaStream(),
    remoteScreenStream: new MediaStream(),
    remoteMainStreamId: null,
    ringTimer: null,
    dropTimer: null,
    speakingMonitor: null,
    micProcessor: null,
  };
  await initMicProcessing();
  if (ctx === null) return; // call ended while RNNoise loaded
  ctx.wrapper = buildWrapper(self, active.remoteId);
  attachLocalTracks();

  store._setLocalStream(localStream);
  store._setMediaFlags(true, localStream.getVideoTracks().length > 0);
  store._setStatus("connecting");

  sendToRemote(active.remoteId, {
    type: "call_accept",
    roomId: active.roomId,
    fromId: self.identityId,
    inviteId: ctx.inviteId,
  } satisfies CallAcceptMessage);

  startSpeakingMonitor();
}

export function declineCall(self: Identity) {
  const active = useCallStore.getState().activeCall;
  if (!active) return;
  clearIncomingTimer();
  sendToRemote(active.remoteId, {
    type: "call_decline",
    roomId: active.roomId,
    fromId: self.identityId,
    inviteId: active.inviteId,
    reason: "declined",
  } satisfies CallDeclineMessage);
  useCallStore.getState()._clear();
}

export function hangUp() {
  const active = useCallStore.getState().activeCall;
  if (active && ctx) {
    sendToRemote(active.remoteId, {
      type: "call_hangup",
      roomId: active.roomId,
      fromId: ctx.self.identityId,
      reason: "hangup",
    } satisfies CallHangupMessage);
  }
  endCallLocal();
}

function endCallLocal() {
  if (ctx?.ringTimer) clearTimeout(ctx.ringTimer);
  clearDropTimer();
  clearIncomingTimer();
  if (ctx?.speakingMonitor) {
    ctx.speakingMonitor.stop();
    ctx.speakingMonitor = null;
  }
  if (ctx?.micProcessor) {
    void ctx.micProcessor.dispose();
    ctx.micProcessor = null;
  }
  ctx?.localStream?.getTracks().forEach((t) => t.stop());
  ctx?.screenStream?.getTracks().forEach((t) => t.stop());
  releaseDisplayAudio();
  ctx?.wrapper?.close();
  ctx = null;
  useCallStore.getState()._clear();
}

let screenShareStarting = false;

export async function startScreenShare(config: ScreenShareQualityOption) {
  const call = ctx;
  if (!call?.wrapper) return;
  // Guard against a double-toggle: without this a second call racing the first
  // (both awaiting the OS picker) overwrites call.screenStream, leaking the
  // first capture's tracks and starting system audio twice.
  if (screenShareStarting || useCallStore.getState().screenOn) return;
  screenShareStarting = true;
  try {
    await startScreenShareInner(call, config);
  } finally {
    screenShareStarting = false;
  }
}

async function startScreenShareInner(
  call: CallContext,
  config: ScreenShareQualityOption,
) {
  if (!call.wrapper) return;
  let capture: DisplayCapture;
  try {
    capture = await captureDisplay(config);
  } catch (err) {
    logScreenShare("capture failed", { name: (err as Error)?.name });
    useCallStore.getState()._setScreenError(describeScreenShareError(err));
    return;
  }
  const { stream } = capture;
  if (ctx !== call) {
    // Call ended while the OS picker was open — release the capture instead
    // of leaking the screen/system-audio stream until app restart.
    stream.getTracks().forEach((t) => t.stop());
    releaseDisplayAudio();
    return;
  }
  const track = stream.getVideoTracks()[0];
  call.screenStream = stream;
  // Install the ended handler before any awaits: WebView2 can drop the capture
  // during setup, and if that fires before the handler is attached the share
  // is stuck "on" with a dead track.
  track.onended = () => {
    logScreenShare("video track ended (teardown)", { readyState: track.readyState });
    void stopScreenShare("ended");
  };
  await applyScreenTrackConstraints(track, config);

  if (ctx !== call) {
    stream.getTracks().forEach((t) => t.stop());
    releaseDisplayAudio();
    return;
  }

  // Screen rides its own sender (and stream/msid), so camera and screen can
  // run at the same time and the remote can tell them apart. The tier
  // downscales from the native capture width to the selected resolution.
  const tierSpec = resolveScreenTierSpec(config, track?.getSettings().width);

  if (call.wrapper.hasVideoSender("screen")) {
    await call.wrapper.replaceVideoTrack(track, "screen");
    if (ctx !== call) {
      stream.getTracks().forEach((t) => t.stop());
      releaseDisplayAudio();
      return;
    }
    call.wrapper.applyVideoTier("screen", tierSpec);
  } else {
    call.wrapper.addVideoTrack(track, stream, "screen", 0, tierSpec);
  }
  if (tierSpec !== "max") useCallStore.getState()._setScreenLinkBps(null);

  // Forward the system audio the OS returned (never the mic — that's a
  // separate call track). Rides the screen stream's msid so the receiver
  // groups it with the screen, not the camera.
  for (const audioTrack of stream.getAudioTracks()) {
    call.wrapper.addTrack(audioTrack, stream);
  }

  const store = useCallStore.getState();
  store._setScreenError(null);
  store._setScreenOn(true);
  store._setLocalStream(stream); // preview the shared screen locally
  sendMediaState();
}

export async function stopScreenShare(source: ScreenStopSource = "user") {
  const call = ctx;
  if (!call) return;
  logScreenShare("stopping screen share", { source });
  const wasSharing = useCallStore.getState().screenOn;
  const tracks = call.screenStream?.getTracks() ?? [];
  for (const track of tracks) {
    await call.wrapper?.detachTrack(track);
    track.stop();
  }
  releaseDisplayAudio();

  if (ctx !== call) return; // call ended mid-teardown; endCallLocal already cleared everything
  call.screenStream = null;
  const store = useCallStore.getState();
  store._setScreenOn(false);
  store._setScreenLinkBps(null);
  store._setLocalStream(call.localStream); // back to the camera/mic stream
  sendMediaState();

  // A stop we didn't start from the in-app control means the OS/WebView ended
  // the capture (the "Stop sharing" bar, or a dropped surface on Windows).
  // Surface it so the share vanishing isn't a silent mystery.
  if (source === "ended" && wasSharing) {
    toast.info("Screen sharing ended", "Your system stopped the screen capture.");
  }
}

export function toggleMic() {
  if (!ctx?.localStream) return;
  setMic(!useCallStore.getState().micOn);
}

export function setMic(enabled: boolean) {
  if (!ctx?.localStream) return;
  const raw = ctx.localStream.getAudioTracks()[0];
  if (!raw) return;
  // Mute the transmitted (processed) track, not the raw capture: disabling
  // the raw mic makes WebKit stop the shared capture unit, and that
  // voice-processing teardown/rebuild audibly changes how the remote's
  // playback sounds on every mute/unmute.
  const processed = ctx.micProcessor?.track;
  if (processed) {
    processed.enabled = enabled;
    raw.enabled = true;
  } else {
    raw.enabled = enabled;
  }
  const store = useCallStore.getState();
  store._setMediaFlags(enabled, store.camOn);
}

export function isCallActive(): boolean {
  return ctx !== null;
}

/** Camera on/off releases the device (and its light) when off, and works on
 * calls that started as voice — turning on mid-call renegotiates. */
export async function toggleCam() {
  const call = ctx;
  if (!call) return;
  const store = useCallStore.getState();
  const current = call.localStream?.getVideoTracks()[0] ?? null;

  if (store.camOn && current) {
    await call.wrapper?.replaceVideoTrack(null, "camera");
    current.stop();
    call.localStream?.removeTrack(current);
    if (ctx === call) {
      const fresh = useCallStore.getState();
      fresh._setMediaFlags(fresh.micOn, false);
      sendMediaState();
    }
    return;
  }

  const cameraStream = await navigator.mediaDevices.getUserMedia({ video: buildVideoConstraints() });
  if (ctx !== call) {
    // Call ended while the camera prompt was open — release it instead of
    // leaving the camera light on for a call that's no longer live.
    cameraStream.getTracks().forEach((t) => t.stop());
    return;
  }
  const track = cameraStream.getVideoTracks()[0];
  if (!call.localStream) call.localStream = new MediaStream();
  call.localStream.addTrack(track);

  if (call.wrapper) {
    if (call.wrapper.hasVideoSender("camera")) {
      await call.wrapper.replaceVideoTrack(track, "camera");
    } else {
      call.wrapper.addVideoTrack(track, call.localStream, "camera");
    }
  }
  if (ctx === call) {
    // Read mic/screen state fresh: the user may have toggled mute or a screen
    // share while the camera permission prompt was open, so the snapshot taken
    // before the await is stale.
    const fresh = useCallStore.getState();
    fresh._setMediaFlags(fresh.micOn, true);
    if (!fresh.screenOn) fresh._setLocalStream(call.localStream);
    sendMediaState();
  }
}

// --- Incoming message handlers (called by the network bridge) ---

export function handleCallMediaState(_self: Identity, msg: CallMediaStateMessage) {
  if (!ctx || msg.fromId !== ctx.remoteId || msg.roomId !== ctx.roomId) return;
  useCallStore.getState()._setRemoteMediaState(msg.camOn, msg.screenOn);
}

export function handleCallInvite(self: Identity, msg: CallInviteMessage) {
  // Busy: already in a 1:1 call OR a room call — auto-decline.
  if (ctx || useCallStore.getState().activeCall || useRoomCallStore.getState().roomId !== null) {
    sendToRemote(msg.fromId, {
      type: "call_decline",
      roomId: msg.roomId,
      fromId: self.identityId,
      inviteId: msg.inviteId,
      reason: "busy",
    } satisfies CallDeclineMessage);
    return;
  }

  useCallStore.getState()._setActiveCall({
    roomId: msg.roomId,
    remoteId: msg.fromId,
    status: "incoming",
    withVideo: msg.withVideo,
    inviteId: msg.inviteId,
  });

  sendToRemote(msg.fromId, {
    type: "call_ringing",
    roomId: msg.roomId,
    fromId: self.identityId,
    inviteId: msg.inviteId,
  } satisfies CallRingingMessage);

  void notifyIfUnfocused("Incoming call", msg.withVideo ? "Video call" : "Voice call");

  clearIncomingTimer();
  incomingTimer = setTimeout(() => {
    incomingTimer = null;
    const active = useCallStore.getState().activeCall;
    if (!active || active.status !== "incoming" || active.inviteId !== msg.inviteId) return;
    sendToRemote(msg.fromId, {
      type: "call_decline",
      roomId: msg.roomId,
      fromId: self.identityId,
      inviteId: msg.inviteId,
      reason: "timeout",
    } satisfies CallDeclineMessage);
    useCallStore.getState()._clear();
    emitCallEvent({ kind: "call-missed", remoteId: msg.fromId });
  }, RING_TIMEOUT_MS);
}

export function handleCallRinging(_self: Identity, msg: CallRingingMessage) {
  if (!ctx || ctx.inviteId !== msg.inviteId) return;
  const status = useCallStore.getState().activeCall?.status;
  if (status === "outgoing" || status === "dialing") {
    useCallStore.getState()._setStatus("ringing");
  }
}

export function handleCallAccept(self: Identity, msg: CallAcceptMessage) {
  if (!ctx || ctx.remoteId !== msg.fromId) return;
  if (msg.inviteId && msg.inviteId !== ctx.inviteId) return; // stale attempt
  // Idempotent: a duplicate/replayed accept must not rebuild the connection —
  // doing so orphans the live RTCPeerConnection and its stats interval.
  if (ctx.wrapper) return;
  if (ctx.ringTimer) {
    clearTimeout(ctx.ringTimer);
    ctx.ringTimer = null;
  }
  // Caller now builds its connection and adds tracks; both sides adding
  // tracks kicks off (glare-safe) perfect negotiation.
  ctx.wrapper = buildWrapper(self, msg.fromId);
  attachLocalTracks();
  useCallStore.getState()._setStatus("connecting");

  startSpeakingMonitor();
}

export function handleCallDecline(_self: Identity, msg: CallDeclineMessage) {
  const mine =
    ctx?.remoteId === msg.fromId ||
    useCallStore.getState().activeCall?.remoteId === msg.fromId;
  if (!mine) return;
  const wasCaller = ctx !== null;
  endCallLocal();
  if (!wasCaller) return;
  if (msg.reason === "busy") emitCallEvent({ kind: "call-busy", remoteId: msg.fromId });
  else if (msg.reason === "timeout") emitCallEvent({ kind: "call-no-answer", remoteId: msg.fromId });
  else emitCallEvent({ kind: "call-declined", remoteId: msg.fromId });
}

export function handleCallHangup(_self: Identity, msg: CallHangupMessage) {
  const active = useCallStore.getState().activeCall;
  const mine = ctx?.remoteId === msg.fromId || active?.remoteId === msg.fromId;
  if (!mine) return;
  const wasRinging = active?.status === "incoming";
  endCallLocal();
  if (msg.reason === "timeout") {
    // Caller gave up ringing us — that's a missed call on our side.
    if (wasRinging) emitCallEvent({ kind: "call-missed", remoteId: msg.fromId });
  } else {
    emitCallEvent({ kind: "call-ended", remoteId: msg.fromId });
  }
}

export async function handleRtcDescription(_self: Identity, msg: RtcDescriptionMessage) {
  if (!ctx?.wrapper || ctx.remoteId !== msg.fromId) return;
  await ctx.wrapper.handleDescription(msg.description);
}

export async function handleRtcCandidate(_self: Identity, msg: RtcCandidateMessage) {
  if (!ctx?.wrapper || ctx.remoteId !== msg.fromId) return;
  await ctx.wrapper.handleCandidate(msg.candidate);
}

/** Applies a live quality change to the screen sender: hints the source frame
 * rate (best-effort — display tracks may ignore it) and re-derives the encoder
 * tier from the current capture width so resolution actually changes. */
export async function updateScreenShareQuality(config: ScreenShareQualityOption) {
  if (!ctx?.wrapper) return;
  const track = ctx.screenStream?.getVideoTracks()[0];
  if (track) await applyScreenTrackConstraints(track, config);
  const tierSpec = resolveScreenTierSpec(config, track?.getSettings().width);
  ctx.wrapper.applyVideoTier("screen", tierSpec);
  if (tierSpec !== "max") useCallStore.getState()._setScreenLinkBps(null);
}

/** Best-effort frame-rate hint on a live getDisplayMedia track. Resolution is
 * handled in the encoder (scaleResolutionDownBy), not here, so switching back
 * up to native stays possible — hence width/height are deliberately omitted. */
async function applyScreenTrackConstraints(
  track: MediaStreamTrack | undefined,
  config: ScreenShareQualityOption,
) {
  if (!track || config.id === "auto" || !config.frameRate) return;
  try {
    await track.applyConstraints({ frameRate: { ideal: config.frameRate } });
  } catch {
    // Display-surface tracks may reject applyConstraints; the encoder-side
    // maxFramerate cap still takes effect.
  }
}
