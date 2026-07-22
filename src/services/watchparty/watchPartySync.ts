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
 * than a long, obvious speed ramp. */
export const HARD_SEEK_THRESHOLD_SEC = 1.0;
/** Below this drift we consider ourselves in sync and play at the base rate;
 * keeps small measurement noise from causing constant speed flip-flop. */
export const NUDGE_DEADZONE_SEC = 0.1;
/** Speed multiplier applied to gently converge sub-threshold drift (±5%). */
export const NUDGE_FACTOR = 0.05;

export type PlaybackSnapshot = {
  controllerId: string;
  controlEpoch: number;
  monotonicSeq: number;
  paused: boolean;
  positionSec: number;
  playbackRate: number;
  audioTrackId: number | "no" | "auto";
  subTrackId: number | "no";
  subDelaySec: number;
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
    subDelaySec: msg.subDelaySec,
    controllerClockMs: msg.controllerClockMs,
  };
}

/**
 * Reducer for one client's view of a party. `apply*` return whether observable
 * state changed (so callers can skip redundant store pushes / mpv commands).
 */
export class WatchPartyState {
  private party: PartyInfo | null = null;
  private controllerId: string | null = null;
  private controlEpoch = 0;
  private snapshot: PlaybackSnapshot | null = null;
  /** Local monotonic clock (ms) when the accepted snapshot arrived. */
  private snapshotRecvLocalMs = 0;

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

  recvLocalMs(): number {
    return this.snapshotRecvLocalMs;
  }

  applyStart(msg: WatchPartyStartMessage): boolean {
    // A start for a different party supersedes only if it's genuinely new; an
    // echo of the active party is a no-op.
    if (this.party && this.party.partyId === msg.partyId) return false;
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
    this.snapshotRecvLocalMs = 0;
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

  applyState(msg: WatchPartyStateMessage, recvLocalMs: number): boolean {
    if (!this.party || this.party.partyId !== msg.partyId) return false;
    if (!this.stateWins(msg)) return false;
    // Adopt the (possibly newer) authority the snapshot asserts.
    this.controlEpoch = msg.controlEpoch;
    this.controllerId = msg.controllerId;
    this.snapshot = snapshotOf(msg);
    this.snapshotRecvLocalMs = recvLocalMs;
    return true;
  }

  applyEnd(msg: WatchPartyEndMessage): boolean {
    if (!this.party || this.party.partyId !== msg.partyId) return false;
    this.party = null;
    this.controllerId = null;
    this.controlEpoch = 0;
    this.snapshot = null;
    this.snapshotRecvLocalMs = 0;
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
 * Where the shared timeline "should" be right now on this follower, projected
 * from the last accepted snapshot. `oneWayDelayMs` (from RttEstimator) accounts
 * for the transit lag between the controller sending and us receiving; it
 * defaults to 0 so projection works before any RTT sample exists.
 */
export function projectTargetPositionSec(
  snapshot: PlaybackSnapshot,
  nowLocalMs: number,
  snapshotRecvLocalMs: number,
  oneWayDelayMs = 0,
): number {
  if (snapshot.paused) return snapshot.positionSec;
  const elapsedMs = Math.max(0, nowLocalMs - snapshotRecvLocalMs) + Math.max(0, oneWayDelayMs);
  return snapshot.positionSec + (elapsedMs / 1000) * snapshot.playbackRate;
}

export type Correction =
  | { kind: "seek"; toSec: number }
  | { kind: "speed"; rate: number };

/**
 * Given where we are vs. where we should be, decide the least-jarring
 * correction: hard-seek for large drift, a gentle speed nudge for small drift,
 * or return to the base rate inside the dead-zone. Stateless — the caller holds
 * mpv state and applies the result.
 */
export function decideCorrection(
  localPosSec: number,
  targetPosSec: number,
  baseRate: number,
  paused: boolean,
): Correction {
  // While paused there's nothing to converge; just hold the base rate so the
  // next un-pause starts clean.
  if (paused) return { kind: "speed", rate: baseRate };
  const drift = targetPosSec - localPosSec; // > 0 ⇒ we're behind and must speed up
  if (Math.abs(drift) > HARD_SEEK_THRESHOLD_SEC) return { kind: "seek", toSec: targetPosSec };
  if (Math.abs(drift) <= NUDGE_DEADZONE_SEC) return { kind: "speed", rate: baseRate };
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
