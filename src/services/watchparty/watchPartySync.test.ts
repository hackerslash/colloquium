import { describe, expect, it } from "vitest";
import type {
  WatchPartyHandoffMessage,
  WatchPartyStartMessage,
  WatchPartyStateMessage,
} from "../../types/wire";
import {
  decideCorrection,
  HARD_SEEK_THRESHOLD_SEC,
  NUDGE_FACTOR,
  projectTargetPositionSec,
  RttEstimator,
  WatchPartyState,
  type PlaybackSnapshot,
} from "./watchPartySync";

const ROOM = "grp_1";
const PARTY = "wp_1";

function start(overrides: Partial<WatchPartyStartMessage> = {}): WatchPartyStartMessage {
  return {
    type: "watch_party_start",
    roomId: ROOM,
    partyId: PARTY,
    streamUrl: "https://example.test/movie.mkv",
    ownerId: "alice",
    startedAt: 1_000,
    ...overrides,
  };
}

function state(overrides: Partial<WatchPartyStateMessage> = {}): WatchPartyStateMessage {
  return {
    type: "watch_party_state",
    roomId: ROOM,
    partyId: PARTY,
    controllerId: "alice",
    controlEpoch: 0,
    monotonicSeq: 1,
    paused: false,
    positionSec: 10,
    playbackRate: 1,
    audioTrackId: "auto",
    subTrackId: "no",
    subDelaySec: 0,
    controllerClockMs: 5_000,
    ...overrides,
  };
}

function handoff(overrides: Partial<WatchPartyHandoffMessage> = {}): WatchPartyHandoffMessage {
  return {
    type: "watch_party_handoff",
    roomId: ROOM,
    partyId: PARTY,
    toId: "bob",
    byId: "alice",
    controlEpoch: 1,
    ...overrides,
  };
}

describe("WatchPartyState — lifecycle & authority", () => {
  it("starts a party with the owner as initial controller", () => {
    const s = new WatchPartyState();
    expect(s.applyStart(start())).toBe(true);
    expect(s.isActive()).toBe(true);
    expect(s.currentControllerId()).toBe("alice");
    expect(s.isController("alice")).toBe(true);
    expect(s.isController("bob")).toBe(false);
    expect(s.info()?.streamUrl).toBe("https://example.test/movie.mkv");
  });

  it("ignores an echoed start for the already-active party", () => {
    const s = new WatchPartyState();
    s.applyStart(start());
    expect(s.applyStart(start())).toBe(false);
  });

  it("ends the party", () => {
    const s = new WatchPartyState();
    s.applyStart(start());
    expect(
      s.applyEnd({ type: "watch_party_end", roomId: ROOM, partyId: PARTY, fromId: "alice" }),
    ).toBe(true);
    expect(s.isActive()).toBe(false);
    expect(s.currentSnapshot()).toBeNull();
  });

  it("rejects messages for a different party id", () => {
    const s = new WatchPartyState();
    s.applyStart(start());
    expect(s.applyState(state({ partyId: "other" }), 0)).toBe(false);
    expect(s.applyEnd({ type: "watch_party_end", roomId: ROOM, partyId: "other", fromId: "x" })).toBe(
      false,
    );
  });
});

describe("WatchPartyState — snapshot convergence (LWW)", () => {
  it("accepts the first snapshot and exposes it", () => {
    const s = new WatchPartyState();
    s.applyStart(start());
    expect(s.applyState(state({ monotonicSeq: 1, positionSec: 10 }), 100)).toBe(true);
    expect(s.currentSnapshot()?.positionSec).toBe(10);
    expect(s.recvLocalMs()).toBe(100);
  });

  it("accepts a strictly newer sequence from the same controller", () => {
    const s = new WatchPartyState();
    s.applyStart(start());
    s.applyState(state({ monotonicSeq: 1, positionSec: 10 }), 100);
    expect(s.applyState(state({ monotonicSeq: 2, positionSec: 20 }), 200)).toBe(true);
    expect(s.currentSnapshot()?.positionSec).toBe(20);
  });

  it("rejects a stale (older) sequence — out-of-order delivery", () => {
    const s = new WatchPartyState();
    s.applyStart(start());
    s.applyState(state({ monotonicSeq: 5, positionSec: 50 }), 100);
    expect(s.applyState(state({ monotonicSeq: 4, positionSec: 40 }), 200)).toBe(false);
    expect(s.currentSnapshot()?.positionSec).toBe(50);
  });

  it("is idempotent — a duplicate of the current snapshot changes nothing", () => {
    const s = new WatchPartyState();
    s.applyStart(start());
    s.applyState(state({ monotonicSeq: 3 }), 100);
    expect(s.applyState(state({ monotonicSeq: 3 }), 200)).toBe(false);
  });

  it("adopts a higher control epoch (new controller) even at a lower seq", () => {
    const s = new WatchPartyState();
    s.applyStart(start());
    s.applyState(state({ controllerId: "alice", controlEpoch: 0, monotonicSeq: 9 }), 100);
    // Bob took over at epoch 1 and starts his own seq at 1.
    expect(
      s.applyState(state({ controllerId: "bob", controlEpoch: 1, monotonicSeq: 1 }), 200),
    ).toBe(true);
    expect(s.currentControllerId()).toBe("bob");
    expect(s.currentControlEpoch()).toBe(1);
  });

  it("rejects a lingering snapshot from the demoted controller (lower epoch)", () => {
    const s = new WatchPartyState();
    s.applyStart(start());
    s.applyState(state({ controllerId: "bob", controlEpoch: 1, monotonicSeq: 1 }), 100);
    expect(
      s.applyState(state({ controllerId: "alice", controlEpoch: 0, monotonicSeq: 99 }), 200),
    ).toBe(false);
    expect(s.currentControllerId()).toBe("bob");
  });

  it("resolves a same-epoch two-controller conflict by smaller id, order-independently", () => {
    // Observer A sees alice then bob; observer B sees bob then alice. Both must
    // converge on the same winner (alice < bob).
    const a = new WatchPartyState();
    a.applyStart(start());
    a.applyState(state({ controllerId: "alice", controlEpoch: 1, monotonicSeq: 1 }), 10);
    a.applyState(state({ controllerId: "bob", controlEpoch: 1, monotonicSeq: 1 }), 20);

    const b = new WatchPartyState();
    b.applyStart(start());
    b.applyState(state({ controllerId: "bob", controlEpoch: 1, monotonicSeq: 1 }), 10);
    b.applyState(state({ controllerId: "alice", controlEpoch: 1, monotonicSeq: 1 }), 20);

    expect(a.currentControllerId()).toBe("alice");
    expect(b.currentControllerId()).toBe("alice");
  });
});

describe("WatchPartyState — hand-off", () => {
  it("transfers control on a higher epoch", () => {
    const s = new WatchPartyState();
    s.applyStart(start());
    expect(s.applyHandoff(handoff({ toId: "bob", controlEpoch: 1 }))).toBe(true);
    expect(s.currentControllerId()).toBe("bob");
    expect(s.isController("bob")).toBe(true);
  });

  it("ignores a stale hand-off at an older epoch", () => {
    const s = new WatchPartyState();
    s.applyStart(start());
    s.applyHandoff(handoff({ toId: "bob", controlEpoch: 2 }));
    expect(s.applyHandoff(handoff({ toId: "carol", controlEpoch: 1 }))).toBe(false);
    expect(s.currentControllerId()).toBe("bob");
  });
});

describe("projectTargetPositionSec", () => {
  const snap = (o: Partial<PlaybackSnapshot> = {}): PlaybackSnapshot => ({
    controllerId: "alice",
    controlEpoch: 0,
    monotonicSeq: 1,
    paused: false,
    positionSec: 100,
    playbackRate: 1,
    audioTrackId: "auto",
    subTrackId: "no",
    subDelaySec: 0,
    controllerClockMs: 0,
    ...o,
  });

  it("holds position while paused", () => {
    expect(projectTargetPositionSec(snap({ paused: true }), 5_000, 1_000)).toBe(100);
  });

  it("advances by wall-clock elapsed while playing", () => {
    // 2s of real time elapsed since the snapshot arrived.
    expect(projectTargetPositionSec(snap(), 3_000, 1_000)).toBeCloseTo(102, 6);
  });

  it("scales elapsed by the playback rate", () => {
    expect(projectTargetPositionSec(snap({ playbackRate: 2 }), 3_000, 1_000)).toBeCloseTo(104, 6);
  });

  it("adds one-way transit delay so we land where the controller already is", () => {
    // 2s elapsed + 200ms one-way delay ⇒ 2.2s ahead of the snapshot position.
    expect(projectTargetPositionSec(snap(), 3_000, 1_000, 200)).toBeCloseTo(102.2, 6);
  });
});

describe("decideCorrection", () => {
  it("hard-seeks when drift exceeds the threshold", () => {
    const c = decideCorrection(100, 100 + HARD_SEEK_THRESHOLD_SEC + 0.5, 1, false);
    expect(c).toEqual({ kind: "seek", toSec: 101.5 });
  });

  it("speeds up (nudge) when behind by a small amount", () => {
    const c = decideCorrection(100, 100.3, 1, false);
    expect(c).toEqual({ kind: "speed", rate: 1 + NUDGE_FACTOR });
  });

  it("slows down (nudge) when ahead by a small amount", () => {
    const c = decideCorrection(100.3, 100, 1, false);
    expect(c).toEqual({ kind: "speed", rate: 1 - NUDGE_FACTOR });
  });

  it("holds the base rate inside the dead-zone", () => {
    expect(decideCorrection(100, 100.05, 1, false)).toEqual({ kind: "speed", rate: 1 });
  });

  it("nudges relative to a non-unity base rate", () => {
    expect(decideCorrection(100, 100.3, 1.5, false)).toEqual({
      kind: "speed",
      rate: 1.5 * (1 + NUDGE_FACTOR),
    });
  });

  it("never nudges while paused", () => {
    expect(decideCorrection(100, 105, 1, true)).toEqual({ kind: "speed", rate: 1 });
  });
});

describe("RttEstimator", () => {
  it("returns 0 delay before any sample", () => {
    expect(new RttEstimator().oneWayDelayMs()).toBe(0);
  });

  it("keeps the smallest RTT and halves it for one-way", () => {
    const e = new RttEstimator();
    e.sample(1_000, 1_300); // 300ms
    e.sample(2_000, 2_120); // 120ms  ← best
    e.sample(3_000, 3_400); // 400ms
    expect(e.rttMs()).toBe(120);
    expect(e.oneWayDelayMs()).toBe(60);
  });

  it("ignores negative (clock-glitch) samples", () => {
    const e = new RttEstimator();
    e.sample(2_000, 1_000);
    expect(e.oneWayDelayMs()).toBe(0);
  });
});
