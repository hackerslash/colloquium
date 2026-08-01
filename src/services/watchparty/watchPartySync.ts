import type {
  WatchPartyEndMessage,
  WatchPartyHandoffMessage,
  WatchPartyStartMessage,
  WatchPartyStateMessage,
} from "../../types/wire";

/**
 * Pure convergence + drift-correction logic for a watch party, with no I/O and
 * all clocks injected — mirrors the PresenterSlotManager style so it's fully
 * unit-testable and deterministic.
 *
 * Authority model: the controller is the single master clock (a logical star
 * over the existing P2P data channel — no server, no relay process). Its
 * `watch_party_state` snapshots are idempotent and last-write-wins by
 * (controlEpoch, monotonicSeq, controllerId). `controlEpoch` bumps on hand-off;
 * the holder of the highest epoch is authoritative, with a deterministic
 * smaller-id tie-break for the (rare) same-epoch conflict. Because ordering is
 * total and idempotent, any peer can re-broadcast the newest snapshot it holds
 * and every observer still converges — that's the relay-like resilience for a
 * viewer that loses its direct link to the owner.
 */

/** Hard-seek if the follower is off by more than this — a jump is less jarring
 * than a long speed ramp. Set well above anything jitter or a nudge in progress
 * can reach, because on a remux a seek can cost an ffmpeg restart. */
export const HARD_SEEK_THRESHOLD_SEC = 2.0;
/** Drift at which a nudge starts, and the lower drift at which it stops. Two
 * thresholds, not one: against a single edge the residual noise walks back and
 * forth across it, and every crossing is a `playbackRate` write that re-times the
 * audio renderer — audible as stutter even though the drift is not. */
export const NUDGE_ENTER_SEC = 0.25;
export const NUDGE_EXIT_SEC = 0.08;
/** Speed multiplier applied to gently converge sub-threshold drift (±5%). */
export const NUDGE_FACTOR = 0.05;
/** Footage every peer must hold before the controller will start playing.
 * Measured against what a peer's pipeline has *produced*, not what its
 * SourceBuffer holds — hls.js caps that far below this. */
export const READY_LEAD_SEC = 60;

export type PlaybackSnapshot = {
  controllerId: string;
  controlEpoch: number;
  monotonicSeq: number;
  paused: boolean;
  positionSec: number;
  playbackRate: number;
  audioTrackId?: number | "no" | "auto";
  subTrackId?: number | "no";
  subDelaySec?: number;
  /** Controller's monotonic clock (ms) at the instant `positionSec` was true. */
  controllerClockMs: number;
};

export type PartyInfo = {
  partyId: string;
  roomId: string;
  streamUrl: string;
  ownerId: string;
  startedAt: number;
};

function snapshotOf(msg: WatchPartyStateMessage): PlaybackSnapshot {
  return {
    controllerId: msg.controllerId,
    controlEpoch: msg.controlEpoch,
    monotonicSeq: msg.monotonicSeq,
    paused: msg.paused,
    positionSec: msg.positionSec,
    playbackRate: msg.playbackRate,
    audioTrackId: msg.audioTrackId,
    subTrackId: msg.subTrackId,
    subDelaySec: msg.subDelaySec ?? 0,
    controllerClockMs: msg.controllerClockMs,
  };
}

/**
 * Which of two parties in the same room is the real one. The earlier start wins,
 * being the one people are already watching, and the smaller partyId breaks the
 * tie — so every peer resolves a split identically whatever order it heard them.
 */
export function startSupersedes(
  incoming: Pick<WatchPartyStartMessage, "partyId" | "startedAt">,
  current: Pick<PartyInfo, "partyId" | "startedAt">,
): boolean {
  if (incoming.startedAt !== current.startedAt) return incoming.startedAt < current.startedAt;
  return incoming.partyId < current.partyId;
}

/**
 * Who takes over when the controller goes silent. Lowest id wins, so every peer
 * computes the same answer from the same member list and there is nothing to
 * negotiate — the winner just claims the next epoch.
 */
export function electController(candidateIds: readonly string[]): string | null {
  let winner: string | null = null;
  for (const id of candidateIds) if (winner === null || id < winner) winner = id;
  return winner;
}

/**
 * Reducer for one client's view of a party. `apply*` return whether observable
 * state changed (so callers can skip redundant store pushes / player commands).
 */
export class WatchPartyState {
  private party: PartyInfo | null = null;
  private controllerId: string | null = null;
  private controlEpoch = 0;
  private snapshot: PlaybackSnapshot | null = null;

  isActive(): boolean {
    return this.party !== null;
  }

  info(): PartyInfo | null {
    return this.party;
  }

  currentSnapshot(): PlaybackSnapshot | null {
    return this.snapshot ? { ...this.snapshot } : null;
  }

  currentControllerId(): string | null {
    return this.controllerId;
  }

  currentControlEpoch(): number {
    return this.controlEpoch;
  }

  isController(selfId: string): boolean {
    return this.controllerId === selfId;
  }

  applyStart(msg: WatchPartyStartMessage): boolean {
    // An echo of the active party is a no-op.
    if (this.party && this.party.partyId === msg.partyId) return false;
    if (this.party && !startSupersedes(msg, this.party)) return false;
    this.party = {
      partyId: msg.partyId,
      roomId: msg.roomId,
      streamUrl: msg.streamUrl,
      ownerId: msg.ownerId,
      startedAt: msg.startedAt,
    };
    this.controllerId = msg.ownerId;
    this.controlEpoch = 0;
    this.snapshot = null;
    return true;
  }

  /**
   * The controller pointed the party at a different file. Not a start: the
   * party, its owner and the epoch all survive. Dropping the snapshot is the
   * point — it describes a position in the *previous* file, and a follower
   * steering by it would seek into the new one at the old offset.
   */
  applySourceChange(streamUrl: string): boolean {
    if (!this.party || this.party.streamUrl === streamUrl) return false;
    this.party = { ...this.party, streamUrl };
    this.snapshot = null;
    return true;
  }

  applyHandoff(msg: WatchPartyHandoffMessage): boolean {
    if (!this.party || this.party.partyId !== msg.partyId) return false;
    const wins =
      msg.controlEpoch > this.controlEpoch ||
      (msg.controlEpoch === this.controlEpoch &&
        (this.controllerId === null || msg.toId < this.controllerId));
    if (!wins) return false;
    this.controlEpoch = msg.controlEpoch;
    this.controllerId = msg.toId;
    return true;
  }

  applyState(msg: WatchPartyStateMessage): boolean {
    if (!this.party || this.party.partyId !== msg.partyId) return false;
    if (!this.stateWins(msg)) return false;
    // Adopt the (possibly newer) authority the snapshot asserts.
    this.controlEpoch = msg.controlEpoch;
    this.controllerId = msg.controllerId;
    this.snapshot = snapshotOf(msg);
    return true;
  }

  /** Ending is destructive for everyone, so only the peer who opened the party
   * or the one currently driving it may close it. */
  applyEnd(msg: WatchPartyEndMessage): boolean {
    if (!this.party || this.party.partyId !== msg.partyId) return false;
    if (msg.fromId !== this.party.ownerId && msg.fromId !== this.controllerId) return false;
    this.party = null;
    this.controllerId = null;
    this.controlEpoch = 0;
    this.snapshot = null;
    return true;
  }

  private stateWins(msg: WatchPartyStateMessage): boolean {
    if (msg.controlEpoch > this.controlEpoch) return true;
    if (msg.controlEpoch < this.controlEpoch) return false;
    // Same epoch.
    if (this.controllerId === null) return true;
    if (msg.controllerId !== this.controllerId) {
      // Two peers believe they hold the same epoch — deterministic tie-break
      // (smaller id wins), same rule as PresenterSlotManager, so every
      // observer resolves the conflict identically regardless of arrival order.
      return msg.controllerId < this.controllerId;
    }
    // Same controller & epoch: strictly newer sequence only (idempotent).
    return this.snapshot === null || msg.monotonicSeq > this.snapshot.monotonicSeq;
  }
}

/**
 * Where the shared timeline should be right now on this follower.
 *
 * Projected from the controller's *own* clock (`controllerClockMs`, translated by
 * `clockOffsetMs`), never from when the snapshot arrived. Arrival time carries the
 * channel's jitter: a snapshot 150 ms late reads as 150 ms behind for the whole
 * heartbeat, then snaps forward when the next is on time. That sawtooth exceeds
 * the dead-zone, so the follower ends up correcting against the network.
 *
 * `oneWayDelayMs` compensates for the transit delay baked into the offset
 * estimate; 0 works before any RTT sample exists.
 */
export function projectTargetPositionSec(
  snapshot: PlaybackSnapshot,
  nowLocalMs: number,
  clockOffsetMs: number,
  oneWayDelayMs = 0,
): number {
  if (snapshot.paused) return snapshot.positionSec;
  const controllerNowMs = nowLocalMs - clockOffsetMs + Math.max(0, oneWayDelayMs);
  const elapsedMs = Math.max(0, controllerNowMs - snapshot.controllerClockMs);
  return snapshot.positionSec + (elapsedMs / 1000) * snapshot.playbackRate;
}

export type Correction =
  | { kind: "seek"; toSec: number }
  | { kind: "speed"; rate: number };

/**
 * The least-jarring correction for the gap between where we are and where we
 * should be. Stateless — the caller holds player state and applies the result.
 *
 * `nudging` (a nudge already in progress) selects between the two thresholds, so
 * a correction runs to completion instead of being abandoned and restarted at the
 * dead-zone edge.
 */
export function decideCorrection(
  localPosSec: number,
  targetPosSec: number,
  baseRate: number,
  paused: boolean,
  nudging = false,
): Correction {
  // While paused there's nothing to converge; just hold the base rate so the
  // next un-pause starts clean.
  if (paused) return { kind: "speed", rate: baseRate };
  const drift = targetPosSec - localPosSec; // > 0 ⇒ we're behind and must speed up
  if (Math.abs(drift) > HARD_SEEK_THRESHOLD_SEC) return { kind: "seek", toSec: targetPosSec };
  const threshold = nudging ? NUDGE_EXIT_SEC : NUDGE_ENTER_SEC;
  if (Math.abs(drift) <= threshold) return { kind: "speed", rate: baseRate };
  const factor = drift > 0 ? 1 + NUDGE_FACTOR : 1 - NUDGE_FACTOR;
  return { kind: "speed", rate: baseRate * factor };
}

/**
 * Estimates one-way delay to the controller from ping/pong round trips. Keeps
 * the smallest RTT seen (least queueing/scheduling noise → best clock estimate,
 * the standard NTP-style min-filter).
 */
export class RttEstimator {
  private bestRttMs = Infinity;

  /** `sendLocalMs`/`recvLocalMs` are this peer's monotonic clock at ping-send
   * and pong-receive. */
  sample(sendLocalMs: number, recvLocalMs: number): void {
    const rtt = recvLocalMs - sendLocalMs;
    if (rtt >= 0 && rtt < this.bestRttMs) this.bestRttMs = rtt;
  }

  oneWayDelayMs(): number {
    return this.bestRttMs === Infinity ? 0 : this.bestRttMs / 2;
  }

  rttMs(): number {
    return this.bestRttMs === Infinity ? 0 : this.bestRttMs;
  }
}

/**
 * Offset between this peer's monotonic clock and the controller's, so a snapshot's
 * `controllerClockMs` can be read locally.
 *
 * Each sample is the true offset plus that message's transit delay, so the
 * smallest is least contaminated — same min-filter as RttEstimator. Reset when the
 * controller changes: `performance.now()` has a per-document origin, so another
 * peer's timestamps are on an unrelated scale.
 */
export class ClockOffsetEstimator {
  private bestOffsetMs = Infinity;

  sample(controllerClockMs: number, recvLocalMs: number): void {
    const offset = recvLocalMs - controllerClockMs;
    if (offset < this.bestOffsetMs) this.bestOffsetMs = offset;
  }

  reset(): void {
    this.bestOffsetMs = Infinity;
  }

  hasSample(): boolean {
    return this.bestOffsetMs !== Infinity;
  }

  offsetMs(): number {
    return this.bestOffsetMs === Infinity ? 0 : this.bestOffsetMs;
  }
}

export type PeerLead = { id: string; primed: boolean };

/** Who is not yet holding enough footage to start. Ids rather than a boolean, so
 * the UI can name whoever everyone is waiting on. */
export function peersNotPrimed(members: readonly PeerLead[]): string[] {
  return members.filter((m) => !m.primed).map((m) => m.id);
}
