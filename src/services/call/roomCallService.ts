import type { Identity } from "../../types/domain";
import type {
  RoomCallBeaconMessage,
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
import { SpeakingMonitor } from "./speakingMonitor";
import {
  HEARTBEAT_MS,
  LEASE_MS,
  PresenterSlotManager,
  SLOT_COUNT,
} from "./PresenterSlotManager";
import { captureDisplay, releaseDisplayAudio } from "./displayMedia";
import { applyMicProcessing, buildMicConstraints, markVoiceTracks } from "./micAudio";
import { resolveScreenTierSpec, type ScreenShareQualityOption } from "./screenShareConfig";
import type { TierSpec } from "./PeerConnectionWrapper";
import { emitCallEvent } from "./callEvents";
import { useRoomCallStore } from "../../stores/useRoomCallStore";
import { useCallStore } from "../../stores/useCallStore";

const VIDEO_CONSTRAINTS: MediaTrackConstraints = {
  width: { ideal: 1920 },
  height: { ideal: 1080 },
  frameRate: { ideal: 30 },
};

/** A peer that neither sends anything (beacons flow every 3s) nor has working
 * media for this long is gone — crashed or hard-disconnected. Explicit leaves
 * are handled by messages; this catches the ones that never say goodbye. */
const PEER_TIMEOUT_MS = 15_000;

/** A peer whose *media* has been stuck failed/disconnected this long is
 * reaped even if its data channel is still delivering beacons — otherwise a
 * peer with healthy signaling but dead ICE (NAT rebind, TURN drop) never
 * satisfies PEER_TIMEOUT_MS's data-silence check and its frozen tile never
 * clears. Mirrors the 1:1 call's CALL_DROP_TIMEOUT_MS. */
const MEDIA_FAILED_TIMEOUT_MS = 20_000;

type Session = {
  self: Identity;
  roomId: string;
  memberIds: string[];
  /** Mic + camera; its msid groups them as the "main" stream at receivers. */
  localStream: MediaStream;
  cameraTrack: MediaStreamTrack | null;
  /** Screen video (+ any display audio) on its own msid so receivers can
   * tell it apart from the camera. */
  screenStream: MediaStream | null;
  /** The quality spec the local share currently runs, so wrappers built for
   * late joiners start with the same encoding instead of adaptive default. */
  screenTierSpec: TierSpec;
  /** Max-mode measured bitrate per remote (each pair has its own link). */
  screenLinkBps: Map<string, number>;
  wrappers: Map<string, PeerConnectionWrapper>;
  /** Remote streams by their wire (msid) id, per participant — classified
   * into main vs screen using the slot's streamId. */
  remoteStreams: Map<string, Map<string, MediaStream>>;
  /** Last time each peer proved it's alive (any message received). */
  lastSeenAt: Map<string, number>;
  /** When each peer's media connection first became disconnected/failed;
   * cleared on reconnect. Reaped independently of data-channel liveness. */
  mediaFailedSinceAt: Map<string, number>;
  /** Effective-slot fingerprint from the previous tick, so a lease expiring
   * silently (crashed presenter) still triggers stream reclassification. */
  slotFingerprint: string;
  slots: PresenterSlotManager;
  tickTimer: ReturnType<typeof setInterval> | null;
  tickCount: number;
  speakingMonitor: SpeakingMonitor | null;
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

/** Room membership at join time is the authorization boundary for every
 * inbound room-call message: without this, any peer who can open a PeerJS
 * data connection to you (e.g. a removed contact who cached your peer id)
 * and knows the room's UUID could puppet its way into a live media
 * negotiation. Every handler below checks the message's claimed sender
 * against this before creating a wrapper or touching slot state. */
function isMember(remoteId: string): boolean {
  return session?.memberIds.includes(remoteId) ?? false;
}

/** Occupancy beacon to ALL room members (in-call or not) so the room shows as
 * active in everyone's sidebar. Lease-based: silence expires us automatically. */
function broadcastBeacon(leaving: boolean) {
  if (!session) return;
  broadcast({
    type: "room_call_beacon",
    roomId: session.roomId,
    fromId: session.self.identityId,
    participants: [session.self.identityId, ...session.wrappers.keys()],
    leaseExpiresAt: Date.now() + LEASE_MS,
    leaving,
  } satisfies RoomCallBeaconMessage);
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

/** The badge shows one number, so report the weakest link — that peer bounds
 * what everyone reliably sees. */
function pushScreenLinkToStore() {
  const store = useRoomCallStore.getState();
  if (!session || session.screenTierSpec !== "max" || session.screenLinkBps.size === 0) {
    store._setScreenLinkBps(null);
    return;
  }
  store._setScreenLinkBps(Math.min(...session.screenLinkBps.values()));
}

// --- Per-participant camera ceilings scale with mesh size so uplink doesn't
// saturate: n <= 2 remotes → 2.5 Mbps, 3-4 → 1.2 Mbps @ 720p, 5+ → 600 kbps.
function cameraCeiling(): number {
  const n = session?.wrappers.size ?? 1;
  return n <= 2 ? 1 : n <= 4 ? 2 : 3;
}

function screenCeiling(): number {
  const n = session?.wrappers.size ?? 1;
  return n <= 3 ? 0 : 1;
}

function updateCeilings() {
  if (!session) return;
  for (const wrapper of session.wrappers.values()) {
    wrapper.setVideoCeiling("camera", cameraCeiling());
    wrapper.setVideoCeiling("screen", screenCeiling());
  }
}

/** The stream id a participant announced for their screen share (if any). */
function screenStreamIdOf(remoteId: string): string | null {
  if (!session) return null;
  const slot = session.slots
    .effective(Date.now())
    .find((s) => s.holderId === remoteId && s.mediaKind === "screen");
  return slot?.streamId ?? null;
}

/** Re-derives main vs screen streams for one participant from what we've
 * received and the current slot state, then pushes to the store. Idempotent —
 * safe to run on every track/mute/slot change (covers the race where screen
 * tracks arrive before the slot claim). */
function reclassifyStreams(remoteId: string) {
  if (!session) return;
  const streams = session.remoteStreams.get(remoteId);
  const store = useRoomCallStore.getState();
  if (!streams || streams.size === 0) {
    store._setParticipantScreenStream(remoteId, null);
    store._bumpMediaVersion();
    return;
  }
  const screenId = screenStreamIdOf(remoteId);
  let main: MediaStream | null = null;
  let screen: MediaStream | null = null;
  for (const [id, stream] of streams) {
    if (screenId && id === screenId) screen = stream;
    else if (!main) main = stream;
  }
  if (main) store._setParticipantStream(remoteId, main);
  store._setParticipantScreenStream(remoteId, screen);
  store._bumpMediaVersion();
}

function reclassifyAll() {
  if (!session) return;
  for (const remoteId of session.remoteStreams.keys()) reclassifyStreams(remoteId);
}

/** Records proof of life for a peer (any message received from it). */
function touchPeer(remoteId: string) {
  session?.lastSeenAt.set(remoteId, Date.now());
}

function slotFingerprintNow(now: number): string {
  if (!session) return "";
  return session.slots
    .effective(now)
    .map((s) => `${s.slotIndex}:${s.holderId}:${s.streamId}`)
    .join("|");
}

function routeRemoteTrack(remoteId: string, track: MediaStreamTrack, streams: readonly MediaStream[]) {
  if (!session) return;
  const stream = streams[0];
  if (!stream) return;
  let byId = session.remoteStreams.get(remoteId);
  if (!byId) {
    byId = new Map();
    session.remoteStreams.set(remoteId, byId);
  }
  byId.set(stream.id, stream);
  // Drop streams whose tracks have all ended (e.g. a finished screen share).
  if (track.readyState === "ended" && stream.getTracks().every((t) => t.readyState === "ended")) {
    byId.delete(stream.id);
  }
  reclassifyStreams(remoteId);
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
    onTrack: (track, streams) => routeRemoteTrack(remoteId, track, streams),
    onQuality: (quality) =>
      useRoomCallStore.getState()._setParticipantQuality(remoteId, quality),
    onScreenBitrate: (bps) => {
      if (!session) return;
      session.screenLinkBps.set(remoteId, bps);
      pushScreenLinkToStore();
    },
    onConnectionStateChange: (state) => {
      useRoomCallStore.getState()._setParticipantConnection(remoteId, state);
      if (state === "connected") {
        session?.mediaFailedSinceAt.delete(remoteId);
      } else if (state === "disconnected" || state === "failed") {
        if (session && !session.mediaFailedSinceAt.has(remoteId)) {
          session.mediaFailedSinceAt.set(remoteId, Date.now());
        }
      }
      // "failed" gets a chance to ICE-restart; only a fully closed connection
      // removes the peer from the mesh immediately — the onTick reaper below
      // catches ones stuck failed/disconnected too long to ever recover.
      if (state === "closed") removePeer(remoteId);
    },
  });

  // Full-mesh audio to every peer; camera/screen video too if currently on
  // (covers late joiners).
  for (const track of session.localStream.getAudioTracks()) {
    wrapper.addTrack(track, session.localStream);
  }
  if (session.cameraTrack) {
    wrapper.addVideoTrack(session.cameraTrack, session.localStream, "camera", cameraCeiling());
  }
  if (session.screenStream) {
    const video = session.screenStream.getVideoTracks()[0];
    if (video) {
      // Late joiners get the same quality spec the share currently runs,
      // not the adaptive default.
      wrapper.addVideoTrack(
        video,
        session.screenStream,
        "screen",
        screenCeiling(),
        session.screenTierSpec,
      );
    }
    for (const audio of session.screenStream.getAudioTracks()) {
      wrapper.addTrack(audio, session.screenStream);
    }
  }

  session.wrappers.set(remoteId, wrapper);
  touchPeer(remoteId); // liveness clock starts now, not at epoch 0
  updateCeilings();
  pushParticipantsToStore();
  return wrapper;
}

function removePeer(remoteId: string) {
  if (!session) return;
  const wrapper = session.wrappers.get(remoteId);
  if (wrapper) {
    wrapper.close();
    session.wrappers.delete(remoteId);
    emitCallEvent({
      kind: "room-participant-left",
      roomId: session.roomId,
      participantId: remoteId,
    });
  }
  session.remoteStreams.delete(remoteId);
  session.lastSeenAt.delete(remoteId);
  session.mediaFailedSinceAt.delete(remoteId);
  session.screenLinkBps.delete(remoteId);
  pushScreenLinkToStore();
  useRoomCallStore.getState()._removeParticipant(remoteId);
  updateCeilings();
  pushParticipantsToStore();
}

export async function joinRoomCall(self: Identity, roomId: string, memberIds: string[]) {
  if (session) return;
  if (useCallStore.getState().activeCall) {
    emitCallEvent({ kind: "room-call-blocked-in-call" });
    return;
  }
  const localStream = await navigator.mediaDevices.getUserMedia({
    audio: buildMicConstraints(),
    video: false,
  });
  markVoiceTracks(localStream);

  session = {
    self,
    roomId,
    memberIds,
    localStream,
    cameraTrack: null,
    screenStream: null,
    screenTierSpec: undefined,
    screenLinkBps: new Map(),
    wrappers: new Map(),
    remoteStreams: new Map(),
    mediaFailedSinceAt: new Map(),
    lastSeenAt: new Map(),
    slotFingerprint: "",
    slots: new PresenterSlotManager(),
    tickTimer: null,
    tickCount: 0,
    speakingMonitor: null,
  };

  const store = useRoomCallStore.getState();
  store._setSession(roomId);
  store._setLocalStream(localStream);
  store._setMicOn(true);
  pushParticipantsToStore();
  pushSlotsToStore();

  broadcast({ type: "room_call_join", roomId, fromId: self.identityId } satisfies RoomCallJoinMessage);
  broadcastBeacon(false);

  session.tickTimer = setInterval(onTick, 1_000);

  const speakingMonitor = new SpeakingMonitor(
    self.identityId,
    localStream,
    () => {
      const receivers = new Map<string, RTCRtpReceiver[]>();
      if (!session) return receivers;
      for (const [remoteId, wrapper] of session.wrappers) {
        const audioReceivers = wrapper.pc
          .getReceivers()
          .filter((r) => r.track && r.track.kind === "audio");
        if (audioReceivers.length > 0) receivers.set(remoteId, audioReceivers);
      }
      return receivers;
    },
    (ids) => useRoomCallStore.getState()._setSpeaking(ids),
  );
  speakingMonitor.start();
  session.speakingMonitor = speakingMonitor;
}

function onTick() {
  if (!session) return;
  const now = Date.now();
  const self = session.self.identityId;
  session.tickCount++;

  // Heartbeat any slot we still hold; if we lost/expired it, stop sharing.
  const held = session.slots.slotHeldBy(self, now);
  if (session.screenStream && held === null) {
    stopScreenShareLocal();
  } else if (held !== null) {
    const hb = session.slots.buildHeartbeat(held, self, now);
    if (hb) broadcast({ ...hb, roomId: session.roomId } satisfies SlotHeartbeatMessage);
  }

  // Occupancy beacon at the slot-heartbeat cadence (every 3rd 1s tick).
  if (session.tickCount % Math.max(1, Math.round(HEARTBEAT_MS / 1_000)) === 0) {
    broadcastBeacon(false);
  }

  // Reap crashed/vanished peers via either signal:
  // - dataStale: no message in PEER_TIMEOUT_MS (they beacon every 3s when
  //   alive) while media also isn't connected — catches a peer that never
  //   really connected, or died on both fronts at once.
  // - mediaStuck: media itself stuck failed/disconnected past
  //   MEDIA_FAILED_TIMEOUT_MS, independent of the data channel — catches dead
  //   ICE whose beacons keep arriving and would otherwise keep lastSeen
  //   looking fresh forever.
  // The inverse — data path dead, media still connected — is left alone on
  // purpose: as long as media keeps delivering, a participant shouldn't be
  // dropped just because a separate signaling channel had a blip.
  for (const [remoteId, wrapper] of [...session.wrappers]) {
    const lastSeen = session.lastSeenAt.get(remoteId) ?? now;
    const dataStale = now - lastSeen > PEER_TIMEOUT_MS && wrapper.pc.connectionState !== "connected";
    const mediaFailedSince = session.mediaFailedSinceAt.get(remoteId);
    const mediaStuck =
      mediaFailedSince !== undefined && now - mediaFailedSince > MEDIA_FAILED_TIMEOUT_MS;
    if (dataStale || mediaStuck) {
      removePeer(remoteId);
    }
  }
  if (!session) return; // removePeer can never end the session today, but be safe

  // A presenter that crashed stops heartbeating and its slot lease expires
  // silently — no message arrives to trigger reclassification, so watch the
  // effective slot state ourselves and re-derive streams when it shifts.
  // (This is what unsticks the frozen screen tile.)
  const fingerprint = slotFingerprintNow(now);
  if (fingerprint !== session.slotFingerprint) {
    session.slotFingerprint = fingerprint;
    reclassifyAll();
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
  broadcastBeacon(true);

  if (session.tickTimer) clearInterval(session.tickTimer);
  if (session.speakingMonitor) {
    session.speakingMonitor.stop();
    session.speakingMonitor = null;
  }
  session.wrappers.forEach((w) => w.close());
  session.localStream.getTracks().forEach((t) => t.stop());
  session.cameraTrack?.stop();
  session.screenStream?.getTracks().forEach((t) => t.stop());
  releaseDisplayAudio();
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

/** Re-applies the current voice settings (noise suppression / voice isolation)
 * to the live mic. Called by the settings store when the user toggles them. */
export async function applyMicSettings(): Promise<void> {
  await applyMicProcessing(session?.localStream);
}

// --- Camera: a plain per-participant toggle, full mesh, no slot involved ---

export async function toggleCam() {
  const call = session;
  if (!call) return;
  if (call.cameraTrack) {
    stopCameraLocal();
    return;
  }

  let track: MediaStreamTrack;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: VIDEO_CONSTRAINTS });
    track = stream.getVideoTracks()[0];
  } catch {
    useRoomCallStore.getState()._setPresentError("Couldn't access the camera.");
    return;
  }

  if (session !== call) {
    // Left the room call while the camera prompt was open — release it
    // instead of leaving the camera light on for a call no longer live.
    track.stop();
    return;
  }

  call.cameraTrack = track;
  call.localStream.addTrack(track);
  track.onended = () => stopCameraLocal();

  for (const wrapper of call.wrappers.values()) {
    if (wrapper.hasVideoSender("camera")) {
      void wrapper.replaceVideoTrack(track, "camera");
    } else {
      wrapper.addVideoTrack(track, call.localStream, "camera", cameraCeiling());
    }
  }
  const store = useRoomCallStore.getState();
  store._setCamOn(true);
  store._setPresentError(null);
  store._bumpMediaVersion();
}

function stopCameraLocal() {
  if (!session?.cameraTrack) return;
  for (const wrapper of session.wrappers.values()) {
    void wrapper.replaceVideoTrack(null, "camera");
  }
  session.cameraTrack.stop();
  session.localStream.removeTrack(session.cameraTrack);
  session.cameraTrack = null;
  const store = useRoomCallStore.getState();
  store._setCamOn(false);
  store._bumpMediaVersion();
}

// --- Screen share: coordinated via the 2 presenter slots ---

export async function startScreenShare(config: ScreenShareQualityOption) {
  const call = session;
  if (!call || call.screenStream) return;
  const now = Date.now();
  const freeIndex = ([0, 1] as const).find((i) => call.slots.isFree(i, now));
  if (freeIndex === undefined) {
    useRoomCallStore.getState()._setPresentError("Both screen-share slots are taken.");
    return;
  }

  // Acquire media BEFORE claiming the slot: the screen picker can be cancelled,
  // and permission can be denied — we don't want to hold a slot for media we
  // never got.
  let stream: MediaStream;
  try {
    ({ stream } = await captureDisplay(config));
  } catch (err) {
    const name = (err as Error)?.name;
    useRoomCallStore
      .getState()
      ._setPresentError(
        name === "NotAllowedError"
          ? "Screen share was cancelled or blocked. On macOS, grant Screen Recording to Haven in System Settings ▸ Privacy & Security."
          : `Screen share isn't available: ${name ?? "unknown error"}.`,
      );
    return;
  }

  if (session !== call) {
    // Left the room call while the OS picker was open — release the capture
    // instead of leaking it (and its "you are sharing" indicator).
    stream.getTracks().forEach((t) => t.stop());
    releaseDisplayAudio();
    return;
  }

  const videoTrack = stream.getVideoTracks()[0];
  const claim = call.slots.buildClaim(freeIndex, call.self.identityId, stream.id, now);
  if (!claim) {
    stream.getTracks().forEach((t) => t.stop());
    return;
  }
  broadcast({ ...claim, roomId: call.roomId } satisfies SlotClaimMessage);
  pushSlotsToStore();

  call.screenStream = stream;
  // Fires when the user clicks the OS/browser "Stop sharing" control.
  videoTrack.onended = () => stopScreenShare();
  await applyScreenTrackConstraints(videoTrack, config);

  if (session !== call) {
    stream.getTracks().forEach((t) => t.stop());
    releaseDisplayAudio();
    return;
  }

  const tierSpec = resolveScreenTierSpec(config, videoTrack?.getSettings().width);
  call.screenTierSpec = tierSpec;
  call.screenLinkBps.clear();
  pushScreenLinkToStore();

  for (const wrapper of call.wrappers.values()) {
    if (wrapper.hasVideoSender("screen")) {
      void wrapper.replaceVideoTrack(videoTrack, "screen");
      wrapper.applyVideoTier("screen", tierSpec);
    } else {
      wrapper.addVideoTrack(videoTrack, stream, "screen", screenCeiling(), tierSpec);
    }
    // System audio only (never the mic); rides the screen stream's msid.
    for (const audioTrack of stream.getAudioTracks()) {
      wrapper.addTrack(audioTrack, stream);
    }
  }
  const store = useRoomCallStore.getState();
  store._setScreenOn(true);
  store._setPresentError(null);
  // Own screen rides the same store slot as remote screens so the stage
  // renders local and remote shares identically.
  store._setParticipantScreenStream(call.self.identityId, stream);
  store._bumpMediaVersion();
}

function stopScreenShareLocal() {
  if (!session?.screenStream) return;
  const tracks = session.screenStream.getTracks();
  for (const wrapper of session.wrappers.values()) {
    for (const track of tracks) void wrapper.detachTrack(track);
  }
  tracks.forEach((t) => t.stop());
  releaseDisplayAudio();
  session.screenStream = null;
  session.screenTierSpec = undefined;
  session.screenLinkBps.clear();
  const store = useRoomCallStore.getState();
  store._setScreenOn(false);
  store._setScreenLinkBps(null);
  store._setParticipantScreenStream(session.self.identityId, null);
  store._bumpMediaVersion();
}

export function stopScreenShare() {
  if (!session) return;
  const held = session.slots.slotHeldBy(session.self.identityId, Date.now());
  if (held !== null) {
    const rel = session.slots.buildRelease(held, session.self.identityId);
    if (rel) broadcast({ ...rel, roomId: session.roomId } satisfies SlotReleaseMessage);
  }
  stopScreenShareLocal();
  pushSlotsToStore();
}

// --- Incoming message handlers ---

export function handleRoomCallJoin(self: Identity, msg: RoomCallJoinMessage) {
  if (!session || session.roomId !== msg.roomId || msg.fromId === self.identityId) return;
  if (!isMember(msg.fromId)) return;
  const isNew = !session.wrappers.has(msg.fromId);
  ensureWrapper(msg.fromId);
  touchPeer(msg.fromId);
  if (isNew) {
    emitCallEvent({
      kind: "room-participant-joined",
      roomId: session.roomId,
      participantId: msg.fromId,
    });
  }
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
  if (!isMember(msg.fromId)) return;
  touchPeer(msg.fromId);
  session.slots.replaceAll(msg.slots);
  for (const participant of [msg.fromId, ...msg.participants]) {
    if (participant !== session.self.identityId && isMember(participant)) ensureWrapper(participant);
  }
  reclassifyAll();
  pushSlotsToStore();
}

export function handleRoomCallLeave(_self: Identity, msg: RoomCallLeaveMessage) {
  if (!session || session.roomId !== msg.roomId) return;
  if (!isMember(msg.fromId)) return;
  removePeer(msg.fromId);
}

/** Beacons double as mesh healing: they prove these peers are in the call, so
 * wire up any we missed (e.g. both joined before the data conn was open). */
export function handleRoomCallBeacon(self: Identity, msg: RoomCallBeaconMessage) {
  if (!session || session.roomId !== msg.roomId || msg.leaving) return;
  if (!isMember(msg.fromId)) return;
  touchPeer(msg.fromId);
  for (const participant of [msg.fromId, ...msg.participants]) {
    if (participant !== self.identityId && isMember(participant) && !session.wrappers.has(participant)) {
      ensureWrapper(participant);
    }
  }
}

export function handleSlotClaim(_self: Identity, msg: SlotClaimMessage) {
  if (!session || session.roomId !== msg.roomId) return;
  if (!isMember(msg.claimantId)) return;
  touchPeer(msg.claimantId);
  session.slots.applyClaim(msg);
  reconcileOwnScreenShare();
  reclassifyAll();
  pushSlotsToStore();
}

export function handleSlotHeartbeat(_self: Identity, msg: SlotHeartbeatMessage) {
  if (!session || session.roomId !== msg.roomId) return;
  if (!isMember(msg.holderId)) return;
  touchPeer(msg.holderId);
  session.slots.applyHeartbeat(msg);
  reconcileOwnScreenShare();
  reclassifyAll();
  pushSlotsToStore();
}

export function handleSlotRelease(_self: Identity, msg: SlotReleaseMessage) {
  if (!session || session.roomId !== msg.roomId) return;
  if (!isMember(msg.holderId)) return;
  touchPeer(msg.holderId);
  session.slots.applyRelease(msg);
  reclassifyAll();
  pushSlotsToStore();
}

/** If a remote claim took the slot we were sharing in, stop our share. */
function reconcileOwnScreenShare() {
  if (!session?.screenStream) return;
  const held = session.slots.slotHeldBy(session.self.identityId, Date.now());
  if (held === null) stopScreenShareLocal();
}

export async function handleRtcDescription(_self: Identity, msg: RtcDescriptionMessage) {
  if (!session || msg.channel !== session.roomId) return;
  if (!isMember(msg.fromId)) return;
  touchPeer(msg.fromId);
  const wrapper = ensureWrapper(msg.fromId);
  await wrapper.handleDescription(msg.description);
}

export async function handleRtcCandidate(_self: Identity, msg: RtcCandidateMessage) {
  if (!session || msg.channel !== session.roomId) return;
  if (!isMember(msg.fromId)) return;
  touchPeer(msg.fromId);
  const wrapper = session.wrappers.get(msg.fromId);
  if (wrapper) await wrapper.handleCandidate(msg.candidate);
}

export function isRoomCallActive(roomId: string): boolean {
  return session?.roomId === roomId;
}

export { SLOT_COUNT, LEASE_MS, HEARTBEAT_MS };

/** Applies a live quality change to every screen sender in the mesh: hints the
 * source frame rate (best-effort) and re-derives the encoder tier from the
 * current capture width so resolution actually changes. */
export async function updateScreenShareQuality(config: ScreenShareQualityOption) {
  if (!session) return;
  const track = session.screenStream?.getVideoTracks()[0];
  if (track) await applyScreenTrackConstraints(track, config);
  const tierSpec = resolveScreenTierSpec(config, track?.getSettings().width);
  session.screenTierSpec = tierSpec;
  if (tierSpec !== "max") session.screenLinkBps.clear();
  pushScreenLinkToStore();
  for (const wrapper of session.wrappers.values()) {
    wrapper.applyVideoTier("screen", tierSpec);
  }
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
