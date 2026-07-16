import type { Identity } from "../../types/domain";
import type {
  RoomCallJoinMessage,
  RoomCallLeaveMessage,
  RoomCallPresenceMessage,
  RtcCandidateMessage,
  RtcDescriptionMessage,
  SlotClaimMessage,
  SlotHeartbeatMessage,
  SlotReleaseMessage,
} from "../../types/wire";
import { getPeerRegistry } from "../peer/registry";
import { derivePeerId } from "../peer/derivePeerId";
import { PeerConnectionWrapper } from "./PeerConnectionWrapper";
import {
  HEARTBEAT_MS,
  LEASE_MS,
  PresenterSlotManager,
  SLOT_COUNT,
} from "./PresenterSlotManager";
import { useRoomCallStore } from "../../stores/useRoomCallStore";

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

type Session = {
  self: Identity;
  roomId: string;
  memberIds: string[];
  localStream: MediaStream;
  videoTrack: MediaStreamTrack | null;
  wrappers: Map<string, PeerConnectionWrapper>;
  slots: PresenterSlotManager;
  tickTimer: ReturnType<typeof setInterval> | null;
};

let session: Session | null = null;

function send(remoteId: string, data: unknown) {
  getPeerRegistry().send(derivePeerId(remoteId), data);
}

function broadcast(data: unknown) {
  if (!session) return;
  for (const id of session.memberIds) {
    if (id !== session.self.identityId) send(id, data);
  }
}

function pushSlotsToStore() {
  if (!session) return;
  useRoomCallStore.getState()._setSlots(session.slots.effective(Date.now()));
}

function pushParticipantsToStore() {
  if (!session) return;
  const present = [session.self.identityId, ...session.wrappers.keys()];
  useRoomCallStore.getState()._setParticipants(Array.from(new Set(present)));
}

function ensureWrapper(remoteId: string): PeerConnectionWrapper {
  if (!session) throw new Error("no active room call");
  const existing = session.wrappers.get(remoteId);
  if (existing) return existing;

  const self = session.self;
  const isPolite = self.identityId > remoteId;
  const wrapper = new PeerConnectionWrapper(isPolite, {
    onDescription: (description) =>
      send(remoteId, {
        type: "rtc_description",
        channel: session!.roomId,
        fromId: self.identityId,
        description,
      } satisfies RtcDescriptionMessage),
    onCandidate: (candidate) =>
      send(remoteId, {
        type: "rtc_candidate",
        channel: session!.roomId,
        fromId: self.identityId,
        candidate,
      } satisfies RtcCandidateMessage),
    onRemoteStream: (stream) =>
      useRoomCallStore.getState()._setParticipantStream(remoteId, stream),
    onQuality: (quality) =>
      useRoomCallStore.getState()._setParticipantQuality(remoteId, quality),
    onConnectionStateChange: (state) => {
      useRoomCallStore.getState()._setParticipantConnection(remoteId, state);
      // "failed" gets a chance to ICE-restart; only a fully closed connection
      // removes the peer from the mesh.
      if (state === "closed") removePeer(remoteId);
    },
  });

  // Always send our audio to every peer (full-mesh audio). If we're currently
  // presenting, send video too.
  for (const track of session.localStream.getAudioTracks()) {
    wrapper.addTrack(track, session.localStream);
  }
  if (session.videoTrack) wrapper.addTrack(session.videoTrack, session.localStream);

  session.wrappers.set(remoteId, wrapper);
  pushParticipantsToStore();
  return wrapper;
}

function removePeer(remoteId: string) {
  if (!session) return;
  const wrapper = session.wrappers.get(remoteId);
  if (wrapper) {
    wrapper.close();
    session.wrappers.delete(remoteId);
  }
  useRoomCallStore.getState()._removeParticipant(remoteId);
  pushParticipantsToStore();
}

export async function joinRoomCall(self: Identity, roomId: string, memberIds: string[]) {
  if (session) return;
  const localStream = await navigator.mediaDevices.getUserMedia({
    audio: AUDIO_CONSTRAINTS,
    video: false,
  });

  session = {
    self,
    roomId,
    memberIds,
    localStream,
    videoTrack: null,
    wrappers: new Map(),
    slots: new PresenterSlotManager(),
    tickTimer: null,
  };

  const store = useRoomCallStore.getState();
  store._setSession(roomId);
  store._setLocalStream(localStream);
  store._setMicOn(true);
  pushParticipantsToStore();
  pushSlotsToStore();

  broadcast({ type: "room_call_join", roomId, fromId: self.identityId } satisfies RoomCallJoinMessage);

  session.tickTimer = setInterval(onTick, 1_000);
}

function onTick() {
  if (!session) return;
  const now = Date.now();
  const self = session.self.identityId;

  // Heartbeat any slot we still hold; if we lost/expired it, stop presenting.
  const held = session.slots.slotHeldBy(self, now);
  if (session.videoTrack && held === null) {
    stopPresentingLocal();
  } else if (held !== null) {
    const hb = session.slots.buildHeartbeat(held, self, now);
    if (hb) broadcast({ ...hb, roomId: session.roomId } satisfies SlotHeartbeatMessage);
  }

  pushSlotsToStore();
}

export function leaveRoomCall() {
  if (!session) return;
  const self = session.self.identityId;

  const held = session.slots.slotHeldBy(self, Date.now());
  if (held !== null) {
    const rel = session.slots.buildRelease(held, self);
    if (rel) broadcast({ ...rel, roomId: session.roomId } satisfies SlotReleaseMessage);
  }
  broadcast({
    type: "room_call_leave",
    roomId: session.roomId,
    fromId: self,
  } satisfies RoomCallLeaveMessage);

  if (session.tickTimer) clearInterval(session.tickTimer);
  session.wrappers.forEach((w) => w.close());
  session.localStream.getTracks().forEach((t) => t.stop());
  session.videoTrack?.stop();
  session = null;
  useRoomCallStore.getState()._clear();
}

export function toggleMic() {
  if (!session) return;
  const track = session.localStream.getAudioTracks()[0];
  if (!track) return;
  setMic(!track.enabled);
}

export function setMic(enabled: boolean) {
  if (!session) return;
  const track = session.localStream.getAudioTracks()[0];
  if (!track) return;
  track.enabled = enabled;
  useRoomCallStore.getState()._setMicOn(enabled);
}

export function isInRoomCall(): boolean {
  return session !== null;
}

export async function startPresenting() {
  if (!session) return;
  const now = Date.now();
  const freeIndex = ([0, 1] as const).find((i) => session!.slots.isFree(i, now));
  if (freeIndex === undefined) {
    useRoomCallStore.getState()._setPresentError("Both presenter slots are taken.");
    return;
  }

  const claim = session.slots.buildClaim(freeIndex, session.self.identityId, "camera", now);
  if (!claim) return;
  broadcast({ ...claim, roomId: session.roomId } satisfies SlotClaimMessage);
  pushSlotsToStore();

  try {
    const videoStream = await navigator.mediaDevices.getUserMedia({ video: VIDEO_CONSTRAINTS });
    const videoTrack = videoStream.getVideoTracks()[0];
    session.videoTrack = videoTrack;
    videoTrack.onended = () => stopPresenting();

    // Add our video to every existing mesh connection (each renegotiates).
    for (const wrapper of session.wrappers.values()) {
      wrapper.addTrack(videoTrack, session.localStream);
    }
    useRoomCallStore.getState()._setPresenting(true);
    useRoomCallStore.getState()._setLocalStream(session.localStream);
  } catch {
    // Couldn't get the camera — release the slot we optimistically claimed.
    stopPresenting();
    useRoomCallStore.getState()._setPresentError("Couldn't access the camera.");
  }
}

function stopPresentingLocal() {
  if (!session?.videoTrack) return;
  for (const wrapper of session.wrappers.values()) {
    void wrapper.replaceVideoTrack(null);
  }
  session.videoTrack.stop();
  session.videoTrack = null;
  useRoomCallStore.getState()._setPresenting(false);
}

export function stopPresenting() {
  if (!session) return;
  const held = session.slots.slotHeldBy(session.self.identityId, Date.now());
  if (held !== null) {
    const rel = session.slots.buildRelease(held, session.self.identityId);
    if (rel) broadcast({ ...rel, roomId: session.roomId } satisfies SlotReleaseMessage);
  }
  stopPresentingLocal();
  pushSlotsToStore();
}

// --- Incoming message handlers ---

export function handleRoomCallJoin(self: Identity, msg: RoomCallJoinMessage) {
  if (!session || session.roomId !== msg.roomId || msg.fromId === self.identityId) return;
  ensureWrapper(msg.fromId);
  send(msg.fromId, {
    type: "room_call_presence",
    roomId: session.roomId,
    fromId: self.identityId,
    participants: [self.identityId, ...session.wrappers.keys()].filter((id) => id !== msg.fromId),
    slots: session.slots.snapshot(),
  } satisfies RoomCallPresenceMessage);
}

export function handleRoomCallPresence(_self: Identity, msg: RoomCallPresenceMessage) {
  if (!session || session.roomId !== msg.roomId) return;
  session.slots.replaceAll(msg.slots);
  for (const participant of [msg.fromId, ...msg.participants]) {
    if (participant !== session.self.identityId) ensureWrapper(participant);
  }
  pushSlotsToStore();
}

export function handleRoomCallLeave(_self: Identity, msg: RoomCallLeaveMessage) {
  if (!session || session.roomId !== msg.roomId) return;
  removePeer(msg.fromId);
}

export function handleSlotClaim(_self: Identity, msg: SlotClaimMessage) {
  if (!session || session.roomId !== msg.roomId) return;
  session.slots.applyClaim(msg);
  reconcileOwnPresenting();
  pushSlotsToStore();
}

export function handleSlotHeartbeat(_self: Identity, msg: SlotHeartbeatMessage) {
  if (!session || session.roomId !== msg.roomId) return;
  session.slots.applyHeartbeat(msg);
  reconcileOwnPresenting();
  pushSlotsToStore();
}

export function handleSlotRelease(_self: Identity, msg: SlotReleaseMessage) {
  if (!session || session.roomId !== msg.roomId) return;
  session.slots.applyRelease(msg);
  pushSlotsToStore();
}

/** If a remote claim took the slot we were presenting in, stop our video. */
function reconcileOwnPresenting() {
  if (!session?.videoTrack) return;
  const held = session.slots.slotHeldBy(session.self.identityId, Date.now());
  if (held === null) stopPresentingLocal();
}

export async function handleRtcDescription(_self: Identity, msg: RtcDescriptionMessage) {
  if (!session || msg.channel !== session.roomId) return;
  const wrapper = ensureWrapper(msg.fromId);
  await wrapper.handleDescription(msg.description);
}

export async function handleRtcCandidate(_self: Identity, msg: RtcCandidateMessage) {
  if (!session || msg.channel !== session.roomId) return;
  const wrapper = session.wrappers.get(msg.fromId);
  if (wrapper) await wrapper.handleCandidate(msg.candidate);
}

export function isRoomCallActive(roomId: string): boolean {
  return session?.roomId === roomId;
}

export { SLOT_COUNT, LEASE_MS, HEARTBEAT_MS };
