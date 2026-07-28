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
  ClockOffsetEstimator,
  decideCorrection,
  NUDGE_EXIT_SEC,
  peersNotPrimed,
  projectTargetPositionSec,
  READY_LEAD_SEC,
  RttEstimator,
  WatchPartyState,
  type PeerLead,
} from "./watchPartySync";
import * as player from "./watchPartyPlayer";
import type { AudioTrackId, SubTrackId, WpEvent } from "./watchPartyPlayer";
import * as roomMembersRepo from "../db/roomMembersRepo";
import { useWatchPartyStore } from "../../stores/useWatchPartyStore";
import { toast } from "../../stores/useToastStore";

const HEARTBEAT_MS = 1_500;
const SYNC_TICK_MS = 500;
const BEACON_MS = 3_000;
const PING_MS = 4_000;
/** Consecutive ticks of hard-seek-sized drift before a follower acts. One tick is
 * not evidence — a late snapshot or a momentary stall produces it, and on a remux
 * a seek outside the produced range costs an ffmpeg restart. */
const DRIFT_STRIKES = 2;
/** Quiet period after a correction, while the element flushes and refills.
 * Deciding again before it reports a real position turns one correction into a
 * run of them. */
const CORRECTION_HOLD_MS = 1_200;

type Ctrl = {
  paused: boolean;
  rate: number;
  audioTrackId: AudioTrackId;
  subTrackId: SubTrackId;
  subDelaySec: number;
};

type MemberInfo = {
  ready: boolean;
  primed: boolean;
  bufferedSec: number;
  leaseExpiresAt: number;
};

type Session = {
  self: Identity;
  roomId: string;
  partyId: string;
  streamUrl: string;
  memberIds: string[];
  reducer: WatchPartyState;
  rtt: RttEstimator;
  clock: ClockOffsetEstimator;
  seq: number;
  ctrl: Ctrl;
  localPaused: boolean;
  appliedRate: number;
  ready: boolean;
  primed: boolean;
  bufferedSec: number;
  /** Controller only: play was asked for but some peer is still filling up. */
  waitingForPeers: boolean;
  /** Follower only: monotonic ms before which no correction is decided. */
  holdUntilMs: number;
  driftStrikes: number;
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
  const targets = new Set([...session.memberIds, ...session.members.keys()]);
  targets.delete(session.self.identityId);
  for (const id of targets) send(id, data);
}

function isController(): boolean {
  return !!session && session.reducer.isController(session.self.identityId);
}

function pushSessionToStore() {
  if (!session) return;
  useWatchPartyStore.getState()._setSession({
    roomId: session.roomId,
    partyId: session.partyId,
    streamUrl: session.streamUrl,
    ownerId: session.reducer.info()?.ownerId ?? null,
    controllerId: session.reducer.currentControllerId(),
  });
}

function pushPlaybackToStore() {
  if (!session) return;
  const store = useWatchPartyStore.getState();
  store._setPlayback({
    // A follower reports this machine, not the snapshot: the controller
    // advertises a reopen as not-playing, and mirroring that would flap the
    // chrome every time the host changes window.
    paused: isController() ? session.ctrl.paused : session.localPaused,
    positionSec: player.positionSec(),
    playbackRate: session.ctrl.rate,
    audioTrackId: session.ctrl.audioTrackId,
    subTrackId: session.ctrl.subTrackId,
    subDelaySec: session.ctrl.subDelaySec,
  });
  store._setController(session.reducer.currentControllerId());
}

/** Everyone the play gate has to agree on: this peer, plus every other one whose
 * beacon lease is still good. */
function gateMembers(): PeerLead[] {
  if (!session) return [];
  const now = Date.now();
  return [
    { id: session.self.identityId, primed: session.primed },
    ...[...session.members.entries()]
      .filter(([, m]) => m.leaseExpiresAt > now)
      .map(([id, m]) => ({ id, primed: m.primed })),
  ];
}

function pushPresenceToStore() {
  if (!session) return;
  const now = Date.now();
  const list = [
    {
      id: session.self.identityId,
      ready: session.ready,
      primed: session.primed,
      bufferedSec: session.bufferedSec,
    },
    ...[...session.members.entries()]
      .filter(([, m]) => m.leaseExpiresAt > now)
      .map(([id, m]) => ({
        id,
        ready: m.ready,
        primed: m.primed,
        bufferedSec: m.bufferedSec,
      })),
  ];
  useWatchPartyStore.getState()._setPresence(list, session.bufferedSec);
}

function onPlayerEvent(e: WpEvent) {
  if (!session) return;
  const store = useWatchPartyStore.getState();
  switch (e.kind) {
    case "time":
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
      store._setBuffering(e.pausedForCache);
      break;
    case "tracks":
      store._setTracks(e.tracks);
      break;
    case "subtitles":
      store._setSubLoading(e.loading, e.progress);
      if (e.failed) {
        toast.error("Couldn't load subtitles", "That track couldn't be read from this source.");
      }
      break;
    case "eof":
      store._setBuffering(false);
      break;
    case "error":
      store._setError(e.message);
      break;
  }
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
  // Read adjacently: `controllerClockMs` must be the instant `pos` was true —
  // that pairing is the basis of every follower's projection.
  const pos = player.positionSec();
  const ts = monoNow();
  session.seq += 1;
  const msg: WatchPartyStateMessage = {
    type: "watch_party_state",
    roomId: session.roomId,
    partyId: session.partyId,
    controllerId: session.self.identityId,
    controlEpoch: session.reducer.currentControlEpoch(),
    monotonicSeq: session.seq,
    // Between windows the controller's playhead is frozen, so the shared timeline
    // is not advancing for anybody. Advertising it as playing makes every
    // follower project past a standing-still master and be dragged back later.
    paused: session.ctrl.paused || player.busy(),
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
    primed: session.primed,
    bufferedSec: session.bufferedSec,
    leaseExpiresAt: Date.now() + LEASE_MS,
    leaving,
  } satisfies WatchPartyMemberMessage);
}

function refreshLocalReadiness() {
  if (!session) return;
  const { leadSec, primed } = player.readiness();
  const changed = primed !== session.primed || Math.abs(leadSec - session.bufferedSec) >= 0.5;
  session.primed = primed;
  session.bufferedSec = leadSec;
  if (changed) pushPresenceToStore();
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
  if (changed) pushPresenceToStore();
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
  if (!session) return;
  refreshLocalReadiness();
  if (isController()) {
    gateTick();
    return;
  }
  followerTick();
}

/** Releases a gated play once every peer has filled up. */
function gateTick() {
  if (!session || !session.waitingForPeers) return;
  const waiting = peersNotPrimed(gateMembers());
  if (waiting.length === 0) {
    applyPause(false);
    return;
  }
  setWaitingFor(waiting);
}

/** Only on a real change: the tick recomputes this twice a second, and a fresh
 * array each time would re-render the overlay with it. */
function setWaitingFor(ids: string[]) {
  const store = useWatchPartyStore.getState();
  const current = store.waitingFor;
  if (current.length === ids.length && current.every((id, i) => id === ids[i])) return;
  store._setWaitingFor(ids);
}

function followerTick() {
  if (!session) return;
  const snap = session.reducer.currentSnapshot();
  if (!snap) return;
  pushPlaybackToStore();
  // Before the busy() guard: pausing an element with no data costs nothing, and
  // without it a window that finishes during a host pause plays on anyway —
  // `openWindow` restores whatever the play state was when it began.
  if (snap.paused && !session.localPaused) void player.setPause(true);
  // Mid-reopen the player's clock belongs to no window, so a correction computed
  // from it would be against a stale position.
  if (player.busy()) return;
  applySnapshotTracks();
  if (!session.ready) return;
  if (!snap.paused && session.localPaused) void player.setPause(false);
  if (snap.paused) {
    // A seek is invisible while paused, so settle up now instead of carrying the
    // offset into the resume where everyone can see it corrected.
    if (Math.abs(player.positionSec() - snap.positionSec) > NUDGE_EXIT_SEC) {
      void player.seek(snap.positionSec);
    }
    return;
  }
  const now = monoNow();
  if (now < session.holdUntilMs) return;

  const target = projectTargetPositionSec(
    snap,
    now,
    session.clock.offsetMs(),
    session.rtt.oneWayDelayMs(),
  );
  const nudging = session.appliedRate !== snap.playbackRate;
  const corr = decideCorrection(player.positionSec(), target, snap.playbackRate, false, nudging);
  if (corr.kind === "seek") {
    session.driftStrikes += 1;
    if (session.driftStrikes < DRIFT_STRIKES) return;
    session.driftStrikes = 0;
    void player.seek(corr.toSec);
    session.appliedRate = snap.playbackRate;
    void player.setSpeed(snap.playbackRate);
    session.holdUntilMs = now + CORRECTION_HOLD_MS;
    return;
  }
  session.driftStrikes = 0;
  if (corr.rate !== session.appliedRate) {
    session.appliedRate = corr.rate;
    void player.setSpeed(corr.rate);
  }
}

/**
 * Mirrors the controller's track selection onto this follower. Ids mean the same
 * thing on every peer because every peer fetches the same source URL (see
 * `WatchPartyStateMessage`).
 *
 * Each applied value is committed only after the player resolves. If it rejects
 * the cached value stays stale, so the next tick retries instead of the
 * diff-guard suppressing it forever. Fields absent from the snapshot are left
 * alone — an older peer simply doesn't send them.
 */
function applySnapshotTracks() {
  if (!session || isController()) return;
  const snap = session.reducer.currentSnapshot();
  if (!snap) return;
  if (snap.audioTrackId !== undefined && snap.audioTrackId !== session.ctrl.audioTrackId) {
    const target = snap.audioTrackId;
    void player.setAudioTrack(target).then(() => {
      if (session) session.ctrl.audioTrackId = target;
    });
  }
  if (snap.subTrackId !== undefined && snap.subTrackId !== session.ctrl.subTrackId) {
    const target = snap.subTrackId;
    // Never extracts: the controller reads the source once and shares the cues, so
    // a miss here just means they haven't arrived and the next tick retries.
    void player.setSubTrack(target, false).then((ok) => {
      if (ok && session) session.ctrl.subTrackId = target;
    });
  }
  if (snap.subDelaySec !== undefined && snap.subDelaySec !== session.ctrl.subDelaySec) {
    const target = snap.subDelaySec;
    void player.setSubDelay(target).then(() => {
      if (session) session.ctrl.subDelaySec = target;
    });
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
    clock: new ClockOffsetEstimator(),
    seq: 0,
    ctrl: defaultCtrl(),
    localPaused: true,
    appliedRate: 1,
    ready: false,
    primed: false,
    bufferedSec: 0,
    waitingForPeers: false,
    holdUntilMs: 0,
    driftStrikes: 0,
    members: new Map(),
    timers: [],
    unsub,
  };
}

export async function startParty(self: Identity, roomId: string, streamUrl: string): Promise<void> {
  if (session) leaveParty();
  const memberIds = await roomMembersRepo.listMembers(roomId);
  session = makeSession(self, roomId, streamUrl, memberIds);
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
  // Loading is driven by the store: `Stage` reacts to `streamUrl` once it has a
  // <video> element to attach to. Calling player.load() here would be a no-op
  // anyway, since Stage only mounts after pushSessionToStore() sets active.
  pushSessionToStore();
  broadcast(startMsg);
  startLoops();
  broadcastState();
}

export async function joinParty(self: Identity, roomId: string): Promise<void> {
  if (session && session.roomId === roomId) return;
  if (session) leaveParty();
  const memberIds = await roomMembersRepo.listMembers(roomId);
  const announced = useWatchPartyStore.getState().announcedByRoom?.[roomId];
  const streamUrl = announced?.streamUrl ?? "";
  session = makeSession(self, roomId, streamUrl, memberIds);
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
  startLoops();
  broadcastMember(false);
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
  session.waitingForPeers = false;
  session.primed = false;
  session.driftStrikes = 0;
  session.holdUntilMs = 0;
  setWaitingFor([]);
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
  broadcast(startMsg);
  broadcastState();
}

function applyPause(paused: boolean): void {
  if (!session) return;
  session.ctrl.paused = paused;
  session.waitingForPeers = false;
  setWaitingFor([]);
  void player.setPause(paused);
  pushPlaybackToStore();
  broadcastState();
}

export function togglePlay(): void {
  if (!session || !isController()) return;
  if (session.waitingForPeers) {
    // A second press while waiting cancels the wait rather than queuing another.
    session.waitingForPeers = false;
    setWaitingFor([]);
    pushPlaybackToStore();
    return;
  }
  if (!session.ctrl.paused) {
    applyPause(true);
    return;
  }
  // Gated on every peer holding READY_LEAD_SEC of footage. Without it the slowest
  // peer starts from an empty buffer and spends its first minute being
  // drift-corrected, each correction outside its produced range an ffmpeg restart.
  const waiting = peersNotPrimed(gateMembers());
  if (waiting.length === 0) {
    applyPause(false);
    return;
  }
  session.waitingForPeers = true;
  setWaitingFor(waiting);
  pushPlaybackToStore();
}

/** Overrides the readiness gate. A peer can be permanently short of the target —
 * a slow link, a transcode that cannot outrun realtime — and waiting forever is
 * worse than starting rough. */
export function startAnyway(): void {
  if (!session || !isController() || !session.waitingForPeers) return;
  applyPause(false);
}

export function seek(sec: number): void {
  if (!session || !isController()) return;
  void player.seek(sec);
  pushPlaybackToStore();
  broadcastState();
}

export function setRate(rate: number): void {
  if (!session || !isController()) return;
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
  pushPlaybackToStore();
  broadcastState();
  void player.setSubTrack(id).then((ok) => {
    if (!ok || !session || !isController() || session.ctrl.subTrackId !== id) return;
    sendSubtitle(null, id);
  });
}

/** Cues for an extracted track, so no follower has to read the source itself.
 * `to` is null to reach the whole party. */
function sendSubtitle(to: string | null, id: SubTrackId): void {
  if (!session || id === "no") return;
  const entry = player.subtitleVtt(id);
  if (!entry) return;
  const msg: WatchPartySubtitleMessage = {
    type: "watch_party_subtitle",
    roomId: session.roomId,
    partyId: session.partyId,
    name: entry.label,
    contentB64: toBase64(new TextEncoder().encode(entry.vtt)),
    subId: id,
    lang: entry.lang,
  };
  if (to) send(to, msg);
  else broadcast(msg);
}

export function setSubDelay(sec: number): void {
  if (!session || !isController()) return;
  session.ctrl.subDelaySec = sec;
  void player.setSubDelay(sec);
  pushPlaybackToStore();
  broadcastState();
}

/** Chunked because `String.fromCharCode(...bytes)` spreads every byte into an
 * argument list and overflows the call stack on any real subtitle file. */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export async function addSubtitle(file: File): Promise<void> {
  if (!session || !isController()) return;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const contentB64 = toBase64(bytes);
  const msg: WatchPartySubtitleMessage = {
    type: "watch_party_subtitle",
    roomId: session.roomId,
    partyId: session.partyId,
    name: file.name,
    contentB64,
  };
  const id = await player.addSubtitle(file.name, bytes);
  if (!session || !isController()) return;
  // The added file is now the showing track. Recording it is what lets a later
  // switch back to "off" reach the followers at all — an unchanged snapshot
  // field is indistinguishable from "no selection was ever made".
  if (id !== null) session.ctrl.subTrackId = id;
  // Ordered delivery on the data channel, so the file lands before the snapshot
  // that selects it.
  broadcast(msg);
  pushPlaybackToStore();
  broadcastState();
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
      session.primed = false;
      session.driftStrikes = 0;
      session.holdUntilMs = 0;
      useWatchPartyStore.getState()._setStreamUrl(msg.streamUrl);
      pushSessionToStore();
    }
  }
}

export function handleState(_self: Identity, msg: WatchPartyStateMessage): void {
  if (!session || session.roomId !== msg.roomId) return;
  const recv = monoNow();
  const previousController = session.reducer.currentControllerId();
  const changed = session.reducer.applyState(msg);
  if (!changed) return;
  const controllerId = session.reducer.currentControllerId();
  // `performance.now()` is measured from a per-document origin, so a new
  // controller's timestamps sit on an unrelated scale and the offset filtered
  // from the previous one is worse than having no estimate at all.
  if (controllerId !== previousController) session.clock.reset();
  if (controllerId === msg.controllerId) session.clock.sample(msg.controllerClockMs, recv);
  // Never from our own snapshot coming back round: the wire `paused` is the
  // effective timeline state, which a reopen sets without anyone asking to pause,
  // so adopting it as intent would latch the controller paused.
  if (isController() && msg.controllerId !== session.self.identityId) {
    session.ctrl.paused = msg.paused;
    session.ctrl.rate = msg.playbackRate;
  }
  pushPlaybackToStore();
}

export function handleHandoff(_self: Identity, msg: WatchPartyHandoffMessage): void {
  if (!session || session.roomId !== msg.roomId) return;
  const changed = session.reducer.applyHandoff(msg);
  if (!changed) return;
  session.clock.reset();
  // A gate armed by the outgoing controller is no longer anyone's to release.
  session.waitingForPeers = false;
  setWaitingFor([]);
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
  if (msg.subId !== undefined) {
    // Filed under the ordinal the snapshot already refers to. Selection is left
    // to `applySnapshotTracks`, which retries every tick until these arrive.
    player.installSubtitle(
      msg.subId,
      msg.name,
      msg.lang ?? null,
      new TextDecoder("utf-8").decode(bytes),
    );
    return;
  }
  void player.addSubtitle(msg.name, bytes).then((id) => {
    // The player shows what it just added, so the cache has to agree — otherwise
    // the controller turning subtitles off is a no-diff and never applied here.
    if (session && id !== null) session.ctrl.subTrackId = id;
  });
}

export function handleMember(_self: Identity, msg: WatchPartyMemberMessage): void {
  if (!session || session.roomId !== msg.roomId) return;
  const isNew = !session.members.has(msg.fromId);
  if (msg.leaving) session.members.delete(msg.fromId);
  else
    session.members.set(msg.fromId, {
      ready: msg.ready,
      // An older build omits it; its lead is the closest stand-in, and erring
      // towards "not primed" only ever makes the gate wait, never start early.
      primed: msg.primed ?? msg.bufferedSec >= READY_LEAD_SEC,
      bufferedSec: msg.bufferedSec,
      leaseExpiresAt: msg.leaseExpiresAt,
    });
  // Cues are shared when the track is chosen, so a peer arriving later would
  // otherwise never see subtitles at all.
  if (isNew && !msg.leaving && isController()) sendSubtitle(msg.fromId, session.ctrl.subTrackId);
  pushPresenceToStore();
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
