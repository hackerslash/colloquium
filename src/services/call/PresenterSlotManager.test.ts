import { describe, expect, it } from "vitest";
import { LEASE_MS, PresenterSlotManager } from "./PresenterSlotManager";

describe("PresenterSlotManager", () => {
  it("claims a free slot carrying the screen stream id", () => {
    const m = new PresenterSlotManager();
    const claim = m.buildClaim(0, "alice", "stream-a", 1_000);
    expect(claim).not.toBeNull();
    expect(claim!.mediaKind).toBe("screen");
    expect(claim!.streamId).toBe("stream-a");
    expect(m.holderOf(0, 1_100)).toBe("alice");
    expect(m.effective(1_100)[0].streamId).toBe("stream-a");
  });

  it("won't claim an occupied slot until its lease expires", () => {
    const m = new PresenterSlotManager();
    m.buildClaim(0, "alice", "stream-a", 1_000);
    expect(m.isFree(0, 1_000)).toBe(false);
    // Fresh manager (a remote observer) with the same claim, then expiry.
    expect(m.isFree(0, 1_000 + LEASE_MS + 1)).toBe(true);
  });

  it("heartbeat renews the lease and preserves the stream id", () => {
    const m = new PresenterSlotManager();
    m.buildClaim(0, "alice", "stream-a", 1_000);
    const hb = m.buildHeartbeat(0, "alice", 5_000);
    expect(hb).not.toBeNull();
    expect(hb!.streamId).toBe("stream-a");
    expect(m.holderOf(0, 5_000 + LEASE_MS - 1)).toBe("alice");
  });

  it("release frees the slot and bumps epoch so stale heartbeats lose", () => {
    const m = new PresenterSlotManager();
    m.buildClaim(0, "alice", "stream-a", 1_000);
    const rel = m.buildRelease(0, "alice");
    expect(rel).not.toBeNull();
    expect(m.holderOf(0, 1_100)).toBeNull();
    // A stale heartbeat at the old epoch must not revive the slot.
    m.applyHeartbeat({
      type: "slot_heartbeat",
      roomId: "r",
      slotIndex: 0,
      holderId: "alice",
      epoch: rel!.epoch,
      leaseExpiresAt: 9_999,
      mediaKind: "screen",
      streamId: "stream-a",
    });
    expect(m.holderOf(0, 1_100)).toBeNull();
  });

  it("higher epoch wins a contested slot", () => {
    const m = new PresenterSlotManager();
    m.applyClaim({
      type: "slot_claim",
      roomId: "r",
      slotIndex: 1,
      claimantId: "bob",
      epoch: 1,
      leaseExpiresAt: 20_000,
      mediaKind: "screen",
      streamId: "stream-b",
    });
    m.applyClaim({
      type: "slot_claim",
      roomId: "r",
      slotIndex: 1,
      claimantId: "carol",
      epoch: 2,
      leaseExpiresAt: 20_000,
      mediaKind: "screen",
      streamId: "stream-c",
    });
    expect(m.holderOf(1, 1_000)).toBe("carol");
    expect(m.effective(1_000)[1].streamId).toBe("stream-c");
  });
});
