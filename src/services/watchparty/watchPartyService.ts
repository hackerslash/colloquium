import type { Identity } from "../../types/domain";
import type {
  WatchPartyEndMessage,
  WatchPartyHandoffMessage,
  WatchPartyMemberMessage,
  WatchPartyPingMessage,
  WatchPartyPongMessage,
  WatchPartyStartMessage,
  WatchPartyStateMessage,
  WatchPartySubtitleMessage,
} from "../../types/wire";
import { getPeerRegistry } from "../peer/registry";
import { derivePeerId } from "../peer/derivePeerId";
import { LEASE_MS } from "../call/PresenterSlotManager";
import {
  decideCorrection,
  projectTargetPositionSec,
  RttEstimator,
  WatchPartyState,
} from "./watchPartySync";
import * as player from "./watchPartyPlayer";
import type { AudioTrackId, SubTrackId, WpEvent } from "./watchPartyPlayer";
import * as roomMembersRepo from "../db/roomMembersRepo";
import { useWatchPartyStore } from "../../stores/useWatchPartyStore";

const HEARTBEAT_MS = 1_500;
const SYNC_TICK_MS = 500;
const BEACON_MS = 3_000;
const PING_MS = 4_000;

type Ctrl = {
  paused: boolean;
  rate: number;
  audioTrackId: AudioTrackId;
  subTrackId: SubTrackId;
  subDelaySec: number;
};

type MemberInfo = { ready: boolean; bufferedSec: number; leaseExpiresAt: number };

type Session = {
  self: Identity;
  roomId: string;
  partyId: string;
  streamUrl: string;
  memberIds: string[];
  reducer: WatchPartyState;
  rtt: RttEstimator;
  seq: number;
  ctrl: Ctrl;
  lastPos: number;
  lastTsMs: number;
  localPaused: boolean;
  appliedRate: number;
  ready: boolean;
  bufferedSec: number;
  members: Map<string, MemberInfo>;
  timers: number[];
  unsub: () => void;
};

let session: Session | null = null;

function monoNow(): number {
  return performance.now();
}

function partyIdFor(roomId: string): string {
  return `wp_${roomId}`;
}

function send(remoteId: string, data: unknown) {
  getPeerRegistry().send(derivePeerId(remoteId), data);
}

function broadcast(data: unknown) {
  if (!session) return;
  for (const id of session.memberIds) {
    if (id !== session.self.identityId) send(id, data);
  }
}

function isController(): boolean {
  return !!session && session.reducer.isController(session.self.identityId);
}

function controllerPositionNow(): { pos: number; ts: number } {
  const now = monoNow();
  if (!session) return { pos: 0, ts: now };
  const pos = session.ctrl.paused
    ? session.lastPos
    : session.lastPos + (Math.max(0, now - session.lastTsMs) / 1000) * session.ctrl.rate;
  return { pos, ts: now };
}

function localPositionNow(): number {
  if (!session) return 0;
  if (session.localPaused) return session.lastPos;
  return session.lastPos + (Math.max(0, monoNow() - session.lastTsMs) / 1000) * session.appliedRate;
}

function pushSessionToStore() {
  if (!session) return;
  const info = session.reducer.info();
  useWatchPartyStore.getState()._setSession({
    roomId: session.roomId,
    partyId: session.partyId,
    streamUrl: session.streamUrl,
    ownerId: info?.ownerId ?? session.self.identityId,
    controllerId: session.reducer.currentControllerId() ?? session.self.identityId,
  });
  useWatchPartyStore.getState()._setMode(player.playerMode());
}

function pushPlaybackToStore() {
  if (!session) return;
  const store = useWatchPartyStore.getState();
  store._setPlayback({
    paused: isController() ? session.ctrl.paused : (session.reducer.currentSnapshot()?.paused ?? session.localPaused),
    positionSec: localPositionNow(),
    playbackRate: session.ctrl.rate,
    audioTrackId: session.ctrl.audioTrackId,
    subTrackId: session.ctrl.subTrackId,
    subDelaySec: session.ctrl.subDelaySec,
  });
  store._setController(session.reducer.currentControllerId());
}

function pushMembersToStore() {
  if (!session) return;
  const now = Date.now();
  const list = [
    { id: session.self.identityId, ready: session.ready, bufferedSec: session.bufferedSec },
    ...[...session.members.entries()]
      .filter(([, m]) => m.leaseExpiresAt > now)
      .map(([id, m]) => ({ id, ready: m.ready, bufferedSec: m.bufferedSec })),
  ];
  useWatchPartyStore.getState()._setMembers(list);
}

function onPlayerEvent(e: WpEvent) {
  if (!session) return;
  const store = useWatchPartyStore.getState();
  switch (e.kind) {
    case "time":
      session.lastPos = e.pos;
      session.lastTsMs = monoNow();
      store._setPlayback({ positionSec: e.pos });
      break;
    case "duration":
      store._setPlayback({ durationSec: e.duration });
      break;
    case "pause":
      session.localPaused = e.paused;
      break;
    case "buffering":
      session.ready = e.ready;
      session.bufferedSec = e.cachedSec;
      store._setBuffering(e.pausedForCache);
      break;
    case "tracks":
      store._setTracks(e.tracks);
      break;
    case "eof":
      store._setBuffering(false);
      break;
    case "error":
      store._setError(e.message);
      break;
  }
}

async function initPlayer(): Promise<void> {
  const native = await player.probeNativeAvailable();
  if (native) await player.initNative();
  useWatchPartyStore.getState()._setMode(player.playerMode());
}

function startLoops() {
  if (!session) return;
  const t1 = window.setInterval(() => {
    if (isController()) broadcastState();
  }, HEARTBEAT_MS);
  const t2 = window.setInterval(syncTick, SYNC_TICK_MS);
  const t3 = window.setInterval(() => {
    broadcastMember(false);
    sweepMembers();
  }, BEACON_MS);
  const t4 = window.setInterval(() => {
    if (!isController()) pingController();
  }, PING_MS);
  session.timers = [t1, t2, t3, t4];
}

function broadcastState() {
  if (!session || !isController()) return;
  const { pos, ts } = controllerPositionNow();
  session.seq += 1;
  const msg: WatchPartyStateMessage = {
    type: "watch_party_state",
    roomId: session.roomId,
    partyId: session.partyId,
    controllerId: session.self.identityId,
    controlEpoch: session.reducer.currentControlEpoch(),
    monotonicSeq: session.seq,
    paused: session.ctrl.paused,
    positionSec: pos,
    playbackRate: session.ctrl.rate,
    audioTrackId: session.ctrl.audioTrackId,
    subTrackId: session.ctrl.subTrackId,
    subDelaySec: session.ctrl.subDelaySec,
    controllerClockMs: ts,
  };
  broadcast(msg);
}

function broadcastMember(leaving: boolean) {
  if (!session) return;
  broadcast({
    type: "watch_party_member",
    roomId: session.roomId,
    partyId: session.partyId,
    fromId: session.self.identityId,
    ready: session.ready,
    bufferedSec: session.bufferedSec,
    leaseExpiresAt: Date.now() + LEASE_MS,
    leaving,
  } satisfies WatchPartyMemberMessage);
}

function sweepMembers() {
  if (!session) return;
  const now = Date.now();
  let changed = false;
  for (const [id, m] of session.members) {
    if (m.leaseExpiresAt <= now) {
      session.members.delete(id);
      changed = true;
    }
  }
  if (changed) pushMembersToStore();
}

function pingController() {
  if (!session) return;
  const controllerId = session.reducer.currentControllerId();
  if (!controllerId || controllerId === session.self.identityId) return;
  send(controllerId, {
    type: "watch_party_ping",
    roomId: session.roomId,
    partyId: session.partyId,
    fromId: session.self.identityId,
    t: monoNow(),
  } satisfies WatchPartyPingMessage);
}

function syncTick() {
  if (!session || isController()) return;
  const snap = session.reducer.currentSnapshot();
  if (!snap) return;
  pushPlaybackToStore();
  if (session.ready === false) return;
  if (snap.paused && !session.localPaused) void player.setPause(true);
  if (!snap.paused && session.localPaused) void player.setPause(false);
  if (snap.paused) return;
  const target = projectTargetPositionSec(
    snap,
    monoNow(),
    session.reducer.recvLocalMs(),
    session.rtt.oneWayDelayMs(),
  );
  const corr = decideCorrection(localPositionNow(), target, snap.playbackRate, snap.paused);
  if (corr.kind === "seek") {
    void player.seek(corr.toSec);
    session.lastPos = corr.toSec;
    session.lastTsMs = monoNow();
    session.appliedRate = snap.playbackRate;
    void player.setSpeed(snap.playbackRate);
  } else if (corr.rate !== session.appliedRate) {
    session.appliedRate = corr.rate;
    void player.setSpeed(corr.rate);
  }
}

function applySnapshotTracks() {
  if (!session || isController()) return;
  const snap = session.reducer.currentSnapshot();
  if (!snap) return;
  if (snap.audioTrackId !== session.ctrl.audioTrackId) {
    session.ctrl.audioTrackId = snap.audioTrackId;
    void player.setAudioTrack(snap.audioTrackId);
  }
  if (snap.subTrackId !== session.ctrl.subTrackId) {
    session.ctrl.subTrackId = snap.subTrackId;
    void player.setSubTrack(snap.subTrackId);
  }
  if (snap.subDelaySec !== session.ctrl.subDelaySec) {
    session.ctrl.subDelaySec = snap.subDelaySec;
    void player.setSubDelay(snap.subDelaySec);
  }
  session.ctrl.rate = snap.playbackRate;
}

function defaultCtrl(): Ctrl {
  return { paused: true, rate: 1, audioTrackId: "auto", subTrackId: "no", subDelaySec: 0 };
}

function makeSession(self: Identity, roomId: string, streamUrl: string, memberIds: string[]): Session {
  const unsub = player.onPlayerEvent(onPlayerEvent);
  return {
    self,
    roomId,
    partyId: partyIdFor(roomId),
    streamUrl,
    memberIds,
    reducer: new WatchPartyState(),
    rtt: new RttEstimator(),
    seq: 0,
    ctrl: defaultCtrl(),
    lastPos: 0,
    lastTsMs: monoNow(),
    localPaused: true,
    appliedRate: 1,
    ready: false,
    bufferedSec: 0,
    members: new Map(),
    timers: [],
    unsub,
  };
}

export async function startParty(self: Identity, roomId: string, streamUrl: string): Promise<void> {
  if (session) leaveParty();
  const memberIds = await roomMembersRepo.listMembers(roomId);
  session = makeSession(self, roomId, streamUrl, memberIds);
  await initPlayer();
  const startMsg: WatchPartyStartMessage = {
    type: "watch_party_start",
    roomId,
    partyId: session.partyId,
    streamUrl,
    ownerId: self.identityId,
    startedAt: Date.now(),
  };
  session.reducer.applyStart(startMsg);
  session.ctrl = defaultCtrl();
  pushSessionToStore();
  await player.load(streamUrl);
  broadcast(startMsg);
  startLoops();
  broadcastState();
  refreshTracksSoon();
}

export async function joinParty(self: Identity, roomId: string): Promise<void> {
  if (session && session.roomId === roomId) return;
  if (session) leaveParty();
  const memberIds = await roomMembersRepo.listMembers(roomId);
  const announced = useWatchPartyStore.getState().announcedByRoom?.[roomId];
  const streamUrl = announced?.streamUrl ?? "";
  session = makeSession(self, roomId, streamUrl, memberIds);
  await initPlayer();
  if (announced) {
    session.reducer.applyStart({
      type: "watch_party_start",
      roomId,
      partyId: session.partyId,
      streamUrl: announced.streamUrl,
      ownerId: announced.ownerId,
      startedAt: Date.now(),
    });
  }
  pushSessionToStore();
  if (streamUrl) await player.load(streamUrl);
  startLoops();
  broadcastMember(false);
  refreshTracksSoon();
}

export function leaveParty(): void {
  if (!session) return;
  broadcastMember(true);
  for (const t of session.timers) window.clearInterval(t);
  session.unsub();
  void player.teardown();
  session = null;
  useWatchPartyStore.getState()._clear();
}

export function endParty(): void {
  if (!session) return;
  broadcast({
    type: "watch_party_end",
    roomId: session.roomId,
    partyId: session.partyId,
    fromId: session.self.identityId,
  } satisfies WatchPartyEndMessage);
  leaveParty();
}

export async function setStreamUrl(url: string): Promise<void> {
  if (!session || !isController()) return;
  session.streamUrl = url;
  session.ctrl = defaultCtrl();
  session.lastPos = 0;
  session.lastTsMs = monoNow();
  const startMsg: WatchPartyStartMessage = {
    type: "watch_party_start",
    roomId: session.roomId,
    partyId: session.partyId,
    streamUrl: url,
    ownerId: session.reducer.info()?.ownerId ?? session.self.identityId,
    startedAt: Date.now(),
  };
  session.reducer.applyStart(startMsg);
  useWatchPartyStore.getState()._setStreamUrl(url);
  await player.load(url);
  broadcast(startMsg);
  broadcastState();
  refreshTracksSoon();
}

export function togglePlay(): void {
  if (!session || !isController()) return;
  session.ctrl.paused = !session.ctrl.paused;
  const { pos } = controllerPositionNow();
  session.lastPos = pos;
  session.lastTsMs = monoNow();
  void player.setPause(session.ctrl.paused);
  pushPlaybackToStore();
  broadcastState();
}

export function seek(sec: number): void {
  if (!session || !isController()) return;
  session.lastPos = sec;
  session.lastTsMs = monoNow();
  void player.seek(sec);
  pushPlaybackToStore();
  broadcastState();
}

export function setRate(rate: number): void {
  if (!session || !isController()) return;
  const { pos } = controllerPositionNow();
  session.lastPos = pos;
  session.lastTsMs = monoNow();
  session.ctrl.rate = rate;
  void player.setSpeed(rate);
  pushPlaybackToStore();
  broadcastState();
}

export function setAudioTrack(id: AudioTrackId): void {
  if (!session || !isController()) return;
  session.ctrl.audioTrackId = id;
  void player.setAudioTrack(id);
  pushPlaybackToStore();
  broadcastState();
}

export function setSubTrack(id: SubTrackId): void {
  if (!session || !isController()) return;
  session.ctrl.subTrackId = id;
  void player.setSubTrack(id);
  pushPlaybackToStore();
  broadcastState();
}

export function setSubDelay(sec: number): void {
  if (!session || !isController()) return;
  session.ctrl.subDelaySec = sec;
  void player.setSubDelay(sec);
  pushPlaybackToStore();
  broadcastState();
}

export async function addSubtitle(file: File): Promise<void> {
  if (!session || !isController()) return;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const contentB64 = btoa(String.fromCharCode(...bytes));
  const subId = `sub_${Date.now()}`;
  const msg: WatchPartySubtitleMessage = {
    type: "watch_party_subtitle",
    roomId: session.roomId,
    partyId: session.partyId,
    subId,
    name: file.name,
    contentB64,
  };
  await player.addSubtitle(file.name, bytes);
  broadcast(msg);
  refreshTracksSoon();
}

export function handControlTo(id: string): void {
  if (!session || !isController()) return;
  const epoch = session.reducer.currentControlEpoch() + 1;
  const msg: WatchPartyHandoffMessage = {
    type: "watch_party_handoff",
    roomId: session.roomId,
    partyId: session.partyId,
    toId: id,
    byId: session.self.identityId,
    controlEpoch: epoch,
  };
  session.reducer.applyHandoff(msg);
  broadcast(msg);
  pushPlaybackToStore();
}

function refreshTracksSoon() {
  window.setTimeout(() => {
    void player.getTracks().then((tracks) => {
      if (session) useWatchPartyStore.getState()._setTracks(tracks);
    });
  }, 800);
}

export function handleStart(_self: Identity, msg: WatchPartyStartMessage): void {
  useWatchPartyStore.getState()._setAnnounced(msg.roomId, {
    partyId: msg.partyId,
    ownerId: msg.ownerId,
    streamUrl: msg.streamUrl,
  });
  if (session && session.roomId === msg.roomId) {
    const changed = session.reducer.applyStart(msg);
    if (changed || session.streamUrl !== msg.streamUrl) {
      session.streamUrl = msg.streamUrl;
      session.ctrl = defaultCtrl();
      useWatchPartyStore.getState()._setStreamUrl(msg.streamUrl);
      if (!isController()) void player.load(msg.streamUrl);
      pushSessionToStore();
      refreshTracksSoon();
    }
  }
}

export function handleState(_self: Identity, msg: WatchPartyStateMessage): void {
  if (!session || session.roomId !== msg.roomId) return;
  const changed = session.reducer.applyState(msg, monoNow());
  if (!changed) return;
  if (!isController()) {
    applySnapshotTracks();
    pushPlaybackToStore();
  }
}

export function handleHandoff(_self: Identity, msg: WatchPartyHandoffMessage): void {
  if (!session || session.roomId !== msg.roomId) return;
  const changed = session.reducer.applyHandoff(msg);
  if (!changed) return;
  if (isController()) {
    session.ctrl.paused = session.localPaused;
    broadcastState();
  }
  pushPlaybackToStore();
}

export function handleSubtitle(_self: Identity, msg: WatchPartySubtitleMessage): void {
  if (!session || session.roomId !== msg.roomId || isController()) return;
  const bin = atob(msg.contentB64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  void player.addSubtitle(msg.name, bytes);
  refreshTracksSoon();
}

export function handleMember(_self: Identity, msg: WatchPartyMemberMessage): void {
  if (!session || session.roomId !== msg.roomId) return;
  if (msg.leaving) session.members.delete(msg.fromId);
  else
    session.members.set(msg.fromId, {
      ready: msg.ready,
      bufferedSec: msg.bufferedSec,
      leaseExpiresAt: msg.leaseExpiresAt,
    });
  pushMembersToStore();
}

export function handlePing(_self: Identity, msg: WatchPartyPingMessage): void {
  if (!session || session.roomId !== msg.roomId) return;
  send(msg.fromId, {
    type: "watch_party_pong",
    roomId: session.roomId,
    partyId: session.partyId,
    fromId: session.self.identityId,
    t: msg.t,
  } satisfies WatchPartyPongMessage);
}

export function handlePong(_self: Identity, msg: WatchPartyPongMessage): void {
  if (!session || session.roomId !== msg.roomId) return;
  session.rtt.sample(msg.t, monoNow());
}

export function handleEnd(_self: Identity, msg: WatchPartyEndMessage): void {
  useWatchPartyStore.getState()._clearAnnounced(msg.roomId);
  if (session && session.roomId === msg.roomId) leaveParty();
}
