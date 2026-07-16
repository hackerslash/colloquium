import type { Identity } from "../../types/domain";
import type {
  CallAcceptMessage,
  CallDeclineMessage,
  CallHangupMessage,
  CallInviteMessage,
  RtcCandidateMessage,
  RtcDescriptionMessage,
} from "../../types/wire";
import { getPeerRegistry } from "../peer/registry";
import { derivePeerId } from "../peer/derivePeerId";
import { PeerConnectionWrapper } from "./PeerConnectionWrapper";
import { useCallStore } from "../../stores/useCallStore";

const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

const VIDEO_CONSTRAINTS: MediaTrackConstraints = {
  width: { ideal: 1280 },
  height: { ideal: 720 },
  frameRate: { ideal: 30 },
};

type CallContext = {
  self: Identity;
  remoteId: string;
  roomId: string;
  wrapper: PeerConnectionWrapper | null;
  localStream: MediaStream | null;
};

let ctx: CallContext | null = null;

function sendToRemote(remoteId: string, data: unknown) {
  getPeerRegistry().send(derivePeerId(remoteId), data);
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
        fromId: self.identityId,
        description,
      } satisfies RtcDescriptionMessage),
    onCandidate: (candidate) =>
      sendToRemote(remoteId, {
        type: "rtc_candidate",
        fromId: self.identityId,
        candidate,
      } satisfies RtcCandidateMessage),
    onRemoteStream: (stream) => useCallStore.getState()._setRemoteStream(stream),
    onConnectionStateChange: (state) => {
      useCallStore.getState()._setConnectionState(state);
      if (state === "connected") useCallStore.getState()._setStatus("active");
      if (state === "failed" || state === "closed") {
        // Phase 5 adds ICE restart before giving up; for now, end the call.
        if (ctx) endCallLocal();
      }
    },
  });
}

function attachLocalTracks() {
  if (!ctx?.wrapper || !ctx.localStream) return;
  for (const track of ctx.localStream.getTracks()) {
    ctx.wrapper.addTrack(track, ctx.localStream);
  }
}

export async function startCall(self: Identity, roomId: string, remoteId: string, withVideo: boolean) {
  if (ctx) return;
  const localStream = await acquireLocalMedia(withVideo);
  ctx = { self, remoteId, roomId, wrapper: null, localStream };

  const store = useCallStore.getState();
  store._setActiveCall({ roomId, remoteId, status: "outgoing" });
  store._setLocalStream(localStream);
  store._setMediaFlags(true, withVideo && localStream.getVideoTracks().length > 0);

  sendToRemote(remoteId, {
    type: "call_invite",
    roomId,
    fromId: self.identityId,
  } satisfies CallInviteMessage);
}

export async function acceptCall(self: Identity) {
  const store = useCallStore.getState();
  const active = store.activeCall;
  if (!active || active.status !== "incoming") return;

  const localStream = await acquireLocalMedia(true);
  ctx = { self, remoteId: active.remoteId, roomId: active.roomId, wrapper: null, localStream };
  ctx.wrapper = buildWrapper(self, active.remoteId);
  attachLocalTracks();

  store._setLocalStream(localStream);
  store._setMediaFlags(true, localStream.getVideoTracks().length > 0);
  store._setStatus("connecting");

  sendToRemote(active.remoteId, {
    type: "call_accept",
    roomId: active.roomId,
    fromId: self.identityId,
  } satisfies CallAcceptMessage);
}

export function declineCall(self: Identity) {
  const active = useCallStore.getState().activeCall;
  if (!active) return;
  sendToRemote(active.remoteId, {
    type: "call_decline",
    roomId: active.roomId,
    fromId: self.identityId,
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
    } satisfies CallHangupMessage);
  }
  endCallLocal();
}

function endCallLocal() {
  ctx?.localStream?.getTracks().forEach((t) => t.stop());
  ctx?.wrapper?.close();
  ctx = null;
  useCallStore.getState()._clear();
}

export function toggleMic() {
  if (!ctx?.localStream) return;
  const track = ctx.localStream.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  const store = useCallStore.getState();
  store._setMediaFlags(track.enabled, store.camOn);
}

export function toggleCam() {
  if (!ctx?.localStream) return;
  const track = ctx.localStream.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  const store = useCallStore.getState();
  store._setMediaFlags(store.micOn, track.enabled);
}

// --- Incoming message handlers (called by the network bridge) ---

export function handleCallInvite(self: Identity, msg: CallInviteMessage) {
  // Busy: auto-decline a second incoming call.
  if (ctx || useCallStore.getState().activeCall) {
    sendToRemote(msg.fromId, {
      type: "call_decline",
      roomId: msg.roomId,
      fromId: self.identityId,
    } satisfies CallDeclineMessage);
    return;
  }
  useCallStore.getState()._setActiveCall({
    roomId: msg.roomId,
    remoteId: msg.fromId,
    status: "incoming",
  });
}

export function handleCallAccept(self: Identity, msg: CallAcceptMessage) {
  if (!ctx || ctx.remoteId !== msg.fromId) return;
  // Caller now builds its connection and adds tracks; both sides adding
  // tracks kicks off (glare-safe) perfect negotiation.
  ctx.wrapper = buildWrapper(self, msg.fromId);
  attachLocalTracks();
  useCallStore.getState()._setStatus("connecting");
}

export function handleCallDecline(_self: Identity, msg: CallDeclineMessage) {
  if (ctx?.remoteId === msg.fromId || useCallStore.getState().activeCall?.remoteId === msg.fromId) {
    endCallLocal();
  }
}

export function handleCallHangup(_self: Identity, msg: CallHangupMessage) {
  if (ctx?.remoteId === msg.fromId || useCallStore.getState().activeCall?.remoteId === msg.fromId) {
    endCallLocal();
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
