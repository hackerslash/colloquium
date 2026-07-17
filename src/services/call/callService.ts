import type { Identity } from "../../types/domain";
import type {
  CallAcceptMessage,
  CallDeclineMessage,
  CallHangupMessage,
  CallInviteMessage,
  CallRingingMessage,
  RtcCandidateMessage,
  RtcDescriptionMessage,
} from "../../types/wire";
import { getOutbox, getPeerRegistry } from "../peer/registry";
import { derivePeerId } from "../peer/derivePeerId";
import { PeerConnectionWrapper } from "./PeerConnectionWrapper";
import { SpeakingMonitor } from "./speakingMonitor";
import { captureDisplay, releaseDisplayAudio, type DisplayCapture } from "./displayMedia";
import { applyMicProcessing, buildMicConstraints, markVoiceTracks } from "./micAudio";
import { resolveScreenTierSpec, type ScreenShareQualityOption } from "./screenShareConfig";
import { emitCallEvent } from "./callEvents";
import { useCallStore } from "../../stores/useCallStore";
import { useRoomCallStore } from "../../stores/useRoomCallStore";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { notifyIfUnfocused } from "../notify";

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
  ringTimer: ReturnType<typeof setTimeout> | null;
  dropTimer: ReturnType<typeof setTimeout> | null;
  speakingMonitor: SpeakingMonitor | null;
};

let ctx: CallContext | null = null;
/** Callee-side ring state (before any ctx exists). */
let incomingTimer: ReturnType<typeof setTimeout> | null = null;

function sendToRemote(remoteId: string, data: unknown) {
  getPeerRegistry().send(derivePeerId(remoteId), data);
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

/** Re-applies the current voice settings (noise suppression / voice isolation)
 * to the live mic. Called by the settings store when the user toggles them. */
export async function applyMicSettings(): Promise<void> {
  await applyMicProcessing(ctx?.localStream);
}

/** Switches the live microphone to the device currently selected in settings.
 * Replaces the audio track on the peer connection sender and restarts the
 * speaking monitor so it analyses the new input stream. No-op when not in a
 * call or when the mic cannot be re-acquired. */
export async function switchMicDevice(): Promise<void> {
  const call = ctx;
  if (!call) return;
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

  // Replace the audio sender's track on the peer connection.
  const sender = call.wrapper?.pc.getSenders().find((s) => s.track?.kind === "audio");
  if (sender) {
    try {
      await sender.replaceTrack(newTrack);
    } catch (err) {
      console.warn("switchMicDevice: replaceTrack failed", err);
    }
  }
  if (ctx !== call) {
    newStream.getTracks().forEach((t) => t.stop());
    return;
  }

  // Stop old audio tracks and swap them out of localStream.
  const oldAudioTracks = call.localStream?.getAudioTracks() ?? [];
  for (const old of oldAudioTracks) {
    call.localStream?.removeTrack(old);
    old.stop();
  }
  if (!call.localStream) call.localStream = new MediaStream();
  call.localStream.addTrack(newTrack);

  // Restart the speaking monitor on the new stream.
  if (call.speakingMonitor) {
    call.speakingMonitor.stop();
    call.speakingMonitor = null;
  }
  startSpeakingMonitor();
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
    onRemoteStream: (stream) => useCallStore.getState()._setRemoteStream(stream),
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
  for (const track of ctx.localStream.getAudioTracks()) {
    ctx.wrapper.addTrack(track, ctx.localStream);
  }
  for (const track of ctx.localStream.getVideoTracks()) {
    ctx.wrapper.addVideoTrack(track, ctx.localStream, "camera");
  }
}

function startSpeakingMonitor() {
  if (!ctx || ctx.speakingMonitor) return;
  const remoteId = ctx.remoteId;
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
    (ids) => useCallStore.getState()._setSpeaking(ids),
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
  const inviteId = crypto.randomUUID();
  ctx = {
    self,
    remoteId,
    roomId,
    inviteId,
    wrapper: null,
    localStream,
    screenStream: null,
    ringTimer: null,
    dropTimer: null,
    speakingMonitor: null,
  };

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
    ringTimer: null,
    dropTimer: null,
    speakingMonitor: null,
  };
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
  ctx?.localStream?.getTracks().forEach((t) => t.stop());
  ctx?.screenStream?.getTracks().forEach((t) => t.stop());
  releaseDisplayAudio();
  ctx?.wrapper?.close();
  ctx = null;
  useCallStore.getState()._clear();
}

export async function startScreenShare(config: ScreenShareQualityOption) {
  const call = ctx;
  if (!call?.wrapper) return;
  let capture: DisplayCapture;
  try {
    capture = await captureDisplay(config);
  } catch (err) {
    const name = (err as Error)?.name;
    useCallStore
      .getState()
      ._setScreenError(
        name === "NotAllowedError"
          ? "Screen share was cancelled or blocked. On macOS, grant Screen Recording to Haven in System Settings ▸ Privacy & Security."
          : `Screen share isn't available: ${name ?? "unknown error"}.`,
      );
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

  track.onended = () => void stopScreenShare();
  const store = useCallStore.getState();
  store._setScreenError(null);
  store._setScreenOn(true);
  store._setLocalStream(stream); // preview the shared screen locally
}

export async function stopScreenShare() {
  const call = ctx;
  if (!call) return;
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
}

export function toggleMic() {
  if (!ctx?.localStream) return;
  const track = ctx.localStream.getAudioTracks()[0];
  if (!track) return;
  setMic(!track.enabled);
}

export function setMic(enabled: boolean) {
  if (!ctx?.localStream) return;
  const track = ctx.localStream.getAudioTracks()[0];
  if (!track) return;
  track.enabled = enabled;
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
    if (ctx === call) store._setMediaFlags(store.micOn, false);
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
    store._setMediaFlags(store.micOn, true);
    if (!store.screenOn) store._setLocalStream(call.localStream);
  }
}

// --- Incoming message handlers (called by the network bridge) ---

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
