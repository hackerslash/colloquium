import { describe, expect, it } from "vitest";
import type {
  WatchPartyHandoffMessage,
  WatchPartyStartMessage,
  WatchPartyStateMessage,
} from "../../types/wire";
import {
  ClockOffsetEstimator,
  decideCorrection,
  electController,
  startSupersedes,
  HARD_SEEK_THRESHOLD_SEC,
  NUDGE_ENTER_SEC,
  NUDGE_EXIT_SEC,
  NUDGE_FACTOR,
  peersNotPrimed,
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
    fromId: "alice",
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
    fromId: "alice",
    streamUrl: "https://example.test/movie.mkv",
    ownerId: "alice",
    startedAt: 1_000,
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
    expect(s.applyState(state({ partyId: "other" }))).toBe(false);
    expect(s.applyEnd({ type: "watch_party_end", roomId: ROOM, partyId: "other", fromId: "x" })).toBe(
      false,
    );
  });

  it("only lets the owner or the controller end the party", () => {
    const s = new WatchPartyState();
    s.applyStart(start());
    const end = (fromId: string) =>
      s.applyEnd({ type: "watch_party_end", roomId: ROOM, partyId: PARTY, fromId });
    // A peer who is merely in the party cannot take the film away from everyone.
    expect(end("mallory")).toBe(false);
    expect(s.isActive()).toBe(true);
    s.applyHandoff(handoff({ toId: "bob" }));
    expect(end("bob")).toBe(true);
  });

  it("keeps the owner able to end after handing control away", () => {
    const s = new WatchPartyState();
    s.applyStart(start());
    s.applyHandoff(handoff({ toId: "bob" }));
    expect(
      s.applyEnd({ type: "watch_party_end", roomId: ROOM, partyId: PARTY, fromId: "alice" }),
    ).toBe(true);
  });
});

describe("WatchPartyState — two parties in one room", () => {
  const EARLY = start({ partyId: "wp_early", startedAt: 1_000, ownerId: "alice" });
  const LATE = start({ partyId: "wp_late", startedAt: 2_000, ownerId: "carol" });

  it("keeps the party that started first, whichever arrives first", () => {
    const heardEarlyFirst = new WatchPartyState();
    heardEarlyFirst.applyStart(EARLY);
    expect(heardEarlyFirst.applyStart(LATE)).toBe(false);

    const heardLateFirst = new WatchPartyState();
    heardLateFirst.applyStart(LATE);
    expect(heardLateFirst.applyStart(EARLY)).toBe(true);

    // Both peers land on the same party regardless of arrival order — that is
    // what stops a late joiner's rival party from hijacking the live one.
    expect(heardEarlyFirst.info()?.partyId).toBe(heardLateFirst.info()?.partyId);
    expect(heardEarlyFirst.info()?.partyId).toBe("wp_early");
    expect(heardEarlyFirst.currentControllerId()).toBe("alice");
  });

  it("breaks a same-instant tie on party id, identically on every peer", () => {
    const a = new WatchPartyState();
    const b = new WatchPartyState();
    const one = start({ partyId: "wp_aaa", startedAt: 1_000, ownerId: "alice" });
    const two = start({ partyId: "wp_zzz", startedAt: 1_000, ownerId: "carol" });
    a.applyStart(one);
    a.applyStart(two);
    b.applyStart(two);
    b.applyStart(one);
    expect(a.info()?.partyId).toBe("wp_aaa");
    expect(b.info()?.partyId).toBe("wp_aaa");
  });

  it("startSupersedes is a strict order — never both directions", () => {
    const early = { partyId: "wp_early", startedAt: 1_000 };
    const late = { partyId: "wp_late", startedAt: 2_000 };
    expect(startSupersedes(early, late)).toBe(true);
    expect(startSupersedes(late, early)).toBe(false);
    expect(startSupersedes(early, early)).toBe(false);
  });
});

describe("WatchPartyState — source change", () => {
  it("drops the snapshot but keeps the party, owner and epoch", () => {
    const s = new WatchPartyState();
    s.applyStart(start());
    s.applyHandoff(handoff({ toId: "bob", controlEpoch: 3 }));
    s.applyState(state({ controllerId: "bob", controlEpoch: 3, positionSec: 900 }));
    expect(s.currentSnapshot()?.positionSec).toBe(900);

    expect(s.applySourceChange("https://example.test/other.mkv")).toBe(true);
    // The old position described a different film; steering by it would seek
    // into the new one at the previous offset.
    expect(s.currentSnapshot()).toBeNull();
    expect(s.info()?.streamUrl).toBe("https://example.test/other.mkv");
    expect(s.info()?.ownerId).toBe("alice");
    expect(s.currentControllerId()).toBe("bob");
    expect(s.currentControlEpoch()).toBe(3);
  });

  it("is a no-op for the same url, and for no party", () => {
    const s = new WatchPartyState();
    expect(s.applySourceChange("https://example.test/movie.mkv")).toBe(false);
    s.applyStart(start());
    expect(s.applySourceChange("https://example.test/movie.mkv")).toBe(false);
  });
});

describe("electController", () => {
  it("picks the lowest id, so every peer picks the same one", () => {
    expect(electController(["carol", "alice", "bob"])).toBe("alice");
    expect(electController(["bob", "carol", "alice"])).toBe("alice");
  });

  it("has no winner when nobody is left", () => {
    expect(electController([])).toBeNull();
  });

  it("converges when two peers both claim the vacant epoch", () => {
    // Alice and Bob disagree about who is still alive, so both claim epoch 1.
    // The smaller-id tie-break settles it without another round.
    const observer = new WatchPartyState();
    observer.applyStart(start());
    observer.applyHandoff(handoff({ toId: "bob", byId: "bob", controlEpoch: 1 }));
    observer.applyHandoff(handoff({ toId: "alice", byId: "alice", controlEpoch: 1 }));
    expect(observer.currentControllerId()).toBe("alice");

    const reversed = new WatchPartyState();
    reversed.applyStart(start());
    reversed.applyHandoff(handoff({ toId: "alice", byId: "alice", controlEpoch: 1 }));
    reversed.applyHandoff(handoff({ toId: "bob", byId: "bob", controlEpoch: 1 }));
    expect(reversed.currentControllerId()).toBe("alice");
  });
});

describe("WatchPartyState — snapshot convergence (LWW)", () => {
  it("accepts the first snapshot and exposes it", () => {
    const s = new WatchPartyState();
    s.applyStart(start());
    expect(s.applyState(state({ monotonicSeq: 1, positionSec: 10 }))).toBe(true);
    expect(s.currentSnapshot()?.positionSec).toBe(10);
  });

  it("accepts a strictly newer sequence from the same controller", () => {
    const s = new WatchPartyState();
    s.applyStart(start());
    s.applyState(state({ monotonicSeq: 1, positionSec: 10 }));
    expect(s.applyState(state({ monotonicSeq: 2, positionSec: 20 }))).toBe(true);
    expect(s.currentSnapshot()?.positionSec).toBe(20);
  });

  it("rejects a stale (older) sequence — out-of-order delivery", () => {
    const s = new WatchPartyState();
    s.applyStart(start());
    s.applyState(state({ monotonicSeq: 5, positionSec: 50 }));
    expect(s.applyState(state({ monotonicSeq: 4, positionSec: 40 }))).toBe(false);
    expect(s.currentSnapshot()?.positionSec).toBe(50);
  });

  it("is idempotent — a duplicate of the current snapshot changes nothing", () => {
    const s = new WatchPartyState();
    s.applyStart(start());
    s.applyState(state({ monotonicSeq: 3 }));
    expect(s.applyState(state({ monotonicSeq: 3 }))).toBe(false);
  });

  it("adopts a higher control epoch (new controller) even at a lower seq", () => {
    const s = new WatchPartyState();
    s.applyStart(start());
    s.applyState(state({ controllerId: "alice", controlEpoch: 0, monotonicSeq: 9 }));
    // Bob took over at epoch 1 and starts his own seq at 1.
    expect(
      s.applyState(state({ controllerId: "bob", controlEpoch: 1, monotonicSeq: 1 })),
    ).toBe(true);
    expect(s.currentControllerId()).toBe("bob");
    expect(s.currentControlEpoch()).toBe(1);
  });

  it("rejects a lingering snapshot from the demoted controller (lower epoch)", () => {
    const s = new WatchPartyState();
    s.applyStart(start());
    s.applyState(state({ controllerId: "bob", controlEpoch: 1, monotonicSeq: 1 }));
    expect(
      s.applyState(state({ controllerId: "alice", controlEpoch: 0, monotonicSeq: 99 })),
    ).toBe(false);
    expect(s.currentControllerId()).toBe("bob");
  });

  it("resolves a same-epoch two-controller conflict by smaller id, order-independently", () => {
    // Observer A sees alice then bob; observer B sees bob then alice. Both must
    // converge on the same winner (alice < bob).
    const a = new WatchPartyState();
    a.applyStart(start());
    a.applyState(state({ controllerId: "alice", controlEpoch: 1, monotonicSeq: 1 }));
    a.applyState(state({ controllerId: "bob", controlEpoch: 1, monotonicSeq: 1 }));

    const b = new WatchPartyState();
    b.applyStart(start());
    b.applyState(state({ controllerId: "bob", controlEpoch: 1, monotonicSeq: 1 }));
    b.applyState(state({ controllerId: "alice", controlEpoch: 1, monotonicSeq: 1 }));

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

  it("advances by elapsed controller time while playing", () => {
    // Local clock runs 1000ms ahead of the controller's, so local 3000 is
    // controller 2000 — 2s past the snapshot's own timestamp of 0.
    expect(projectTargetPositionSec(snap(), 3_000, 1_000)).toBeCloseTo(102, 6);
  });

  it("scales elapsed by the playback rate", () => {
    expect(projectTargetPositionSec(snap({ playbackRate: 2 }), 3_000, 1_000)).toBeCloseTo(104, 6);
  });

  it("adds one-way transit delay so we land where the controller already is", () => {
    // 2s elapsed + 200ms one-way delay ⇒ 2.2s ahead of the snapshot position.
    expect(projectTargetPositionSec(snap(), 3_000, 1_000, 200)).toBeCloseTo(102.2, 6);
  });

  it("is unmoved by when the snapshot happened to arrive", () => {
    // The regression this whole projection exists for. Two snapshots describe the
    // same timeline — the second is 1s newer by the controller's own clock — but
    // the second was delayed 400ms in transit. Projected at the same instant they
    // must agree, or that 400ms of jitter becomes 400ms of phantom drift and the
    // follower corrects against the network instead of the film.
    const first = snap({ positionSec: 100, controllerClockMs: 10_000 });
    const late = snap({ positionSec: 101, controllerClockMs: 11_000 });
    const offsetMs = 1_000; // filtered from the least-delayed sample
    const at = 13_000;
    expect(projectTargetPositionSec(late, at, offsetMs)).toBeCloseTo(
      projectTargetPositionSec(first, at, offsetMs),
      6,
    );
  });
});

describe("ClockOffsetEstimator", () => {
  it("returns 0 before any sample", () => {
    const e = new ClockOffsetEstimator();
    expect(e.hasSample()).toBe(false);
    expect(e.offsetMs()).toBe(0);
  });

  it("keeps the smallest offset — the least-delayed message", () => {
    const e = new ClockOffsetEstimator();
    e.sample(1_000, 1_400); // 400ms of transit
    e.sample(2_000, 2_120); // 120ms  ← least contaminated
    e.sample(3_000, 3_900); // 900ms
    expect(e.offsetMs()).toBe(120);
  });

  it("keeps a negative offset — the two clocks have unrelated origins", () => {
    const e = new ClockOffsetEstimator();
    e.sample(9_000, 1_100);
    expect(e.offsetMs()).toBe(-7_900);
  });

  it("forgets everything on reset, for a new controller's clock", () => {
    const e = new ClockOffsetEstimator();
    e.sample(1_000, 1_050);
    e.reset();
    expect(e.hasSample()).toBe(false);
    expect(e.offsetMs()).toBe(0);
  });
});

describe("peersNotPrimed", () => {
  it("names only the peers still filling up", () => {
    expect(
      peersNotPrimed([
        { id: "alice", primed: true },
        { id: "bob", primed: false },
        { id: "carol", primed: false },
      ]),
    ).toEqual(["bob", "carol"]);
  });

  it("is empty when everyone is ready", () => {
    expect(peersNotPrimed([{ id: "alice", primed: true }])).toEqual([]);
  });
});

describe("decideCorrection", () => {
  it("hard-seeks when drift exceeds the threshold", () => {
    const target = 100 + HARD_SEEK_THRESHOLD_SEC + 0.5;
    expect(decideCorrection(100, target, 1, false)).toEqual({ kind: "seek", toSec: target });
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

  it("does not start nudging in the gap between the two thresholds", () => {
    const drift = (NUDGE_ENTER_SEC + NUDGE_EXIT_SEC) / 2;
    expect(decideCorrection(100, 100 + drift, 1, false, false)).toEqual({
      kind: "speed",
      rate: 1,
    });
  });

  it("keeps nudging in that same gap once it has started", () => {
    // The hysteresis. Without it this drift level flips the rate on and off every
    // tick, and each flip is an audible re-time of the audio renderer.
    const drift = (NUDGE_ENTER_SEC + NUDGE_EXIT_SEC) / 2;
    expect(decideCorrection(100, 100 + drift, 1, false, true)).toEqual({
      kind: "speed",
      rate: 1 + NUDGE_FACTOR,
    });
  });

  it("stops nudging once converged below the exit threshold", () => {
    expect(decideCorrection(100, 100 + NUDGE_EXIT_SEC / 2, 1, false, true)).toEqual({
      kind: "speed",
      rate: 1,
    });
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
