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
import type { ScreenShareQualityOption } from "./screenShareConfig";
import { emitCallEvent } from "./callEvents";
import { useCallStore } from "../../stores/useCallStore";
import { useRoomCallStore } from "../../stores/useRoomCallStore";
import { notifyIfUnfocused } from "../notify";

const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

const VIDEO_CONSTRAINTS: MediaTrackConstraints = {
  width: { ideal: 1920 },
  height: { ideal: 1080 },
  frameRate: { ideal: 30 },
};

/** How long an undeliverable invite waits in the Outbox before the call is
 * abandoned as unreachable. */
const INVITE_TTL_MS = 10_000;
/** Ring timeout on both sides. */
const RING_TIMEOUT_MS = 30_000;

type CallContext = {
  self: Identity;
  remoteId: string;
  roomId: string;
  inviteId: string;
  wrapper: PeerConnectionWrapper | null;
  localStream: MediaStream | null;
  screenStream: MediaStream | null;
  ringTimer: ReturnType<typeof setTimeout> | null;
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

async function acquireLocalMedia(withVideo: boolean): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: AUDIO_CONSTRAINTS,
      video: withVideo ? VIDEO_CONSTRAINTS : false,
    });
  } catch {
    // Fall back to audio-only if the camera is unavailable/denied.
    return navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS });
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
    onConnectionStateChange: (state) => {
      useCallStore.getState()._setConnectionState(state);
      if (state === "connected") useCallStore.getState()._setStatus("active");
      // Don't hang up on "disconnected"/"failed" — the wrapper's ICE-restart
      // layer tries to recover, and the UI shows a reconnecting state. Only a
      // fully closed connection (explicit teardown) ends the call here.
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

  // Voice calls stay voice: the camera only opens when the caller asked for
  // video. Either side can still turn their camera on later.
  const localStream = await acquireLocalMedia(active.withVideo);
  ctx = {
    self,
    remoteId: active.remoteId,
    roomId: active.roomId,
    inviteId: active.inviteId ?? crypto.randomUUID(),
    wrapper: null,
    localStream,
    screenStream: null,
    ringTimer: null,
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
  if (!ctx?.wrapper) return;
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
  const track = stream.getVideoTracks()[0];
  ctx.screenStream = stream;

  // Screen rides its own sender (and stream/msid), so camera and screen can
  // run at the same time and the remote can tell them apart.
  const customTier = config.id !== "auto" && config.maxBitrate ? {
    maxBitrate: config.maxBitrate,
    scaleResolutionDownBy: 1,
    maxFramerate: config.frameRate ?? 30,
  } : undefined;

  if (ctx.wrapper.hasVideoSender("screen")) {
    await ctx.wrapper.replaceVideoTrack(track, "screen");
  } else {
    ctx.wrapper.addVideoTrack(track, stream, "screen", 0, customTier);
  }

  // Forward the system audio the OS returned (never the mic — that's a
  // separate call track). Rides the screen stream's msid so the receiver
  // groups it with the screen, not the camera.
  for (const audioTrack of stream.getAudioTracks()) {
    ctx.wrapper.addTrack(audioTrack, stream);
  }

  track.onended = () => void stopScreenShare();
  const store = useCallStore.getState();
  store._setScreenError(null);
  store._setScreenOn(true);
  store._setLocalStream(stream); // preview the shared screen locally
}

export async function stopScreenShare() {
  if (!ctx) return;
  const tracks = ctx.screenStream?.getTracks() ?? [];
  for (const track of tracks) {
    await ctx.wrapper?.detachTrack(track);
    track.stop();
  }
  ctx.screenStream = null;
  releaseDisplayAudio();

  const store = useCallStore.getState();
  store._setScreenOn(false);
  store._setLocalStream(ctx.localStream); // back to the camera/mic stream
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
  if (!ctx) return;
  const store = useCallStore.getState();
  const current = ctx.localStream?.getVideoTracks()[0] ?? null;

  if (store.camOn && current) {
    await ctx.wrapper?.replaceVideoTrack(null, "camera");
    current.stop();
    ctx.localStream?.removeTrack(current);
    store._setMediaFlags(store.micOn, false);
    return;
  }

  let cameraStream: MediaStream;
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: VIDEO_CONSTRAINTS });
  } catch {
    return; // camera unavailable/denied — stay audio-only
  }
  const track = cameraStream.getVideoTracks()[0];
  if (!ctx.localStream) ctx.localStream = new MediaStream();
  ctx.localStream.addTrack(track);

  if (ctx.wrapper) {
    if (ctx.wrapper.hasVideoSender("camera")) {
      await ctx.wrapper.replaceVideoTrack(track, "camera");
    } else {
      ctx.wrapper.addVideoTrack(track, ctx.localStream, "camera");
    }
  }
  store._setMediaFlags(store.micOn, true);
  if (!store.screenOn) store._setLocalStream(ctx.localStream);
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
