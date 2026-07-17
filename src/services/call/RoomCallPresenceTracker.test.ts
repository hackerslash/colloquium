import { describe, expect, it } from "vitest";
import { RoomCallPresenceTracker } from "./RoomCallPresenceTracker";

function beacon(
  roomId: string,
  fromId: string,
  leaseExpiresAt: number,
  participants: string[] = [],
  leaving = false,
) {
  return {
    type: "room_call_beacon" as const,
    roomId,
    fromId,
    participants,
    leaseExpiresAt,
    leaving,
  };
}

describe("RoomCallPresenceTracker", () => {
  it("marks the sender and reported participants active until the lease expires", () => {
    const t = new RoomCallPresenceTracker();
    t.applyBeacon(beacon("r1", "alice", 10_000, ["alice", "bob"]));
    expect(t.activeParticipants("r1", 5_000).sort()).toEqual(["alice", "bob"]);
    expect(t.activeParticipants("r1", 10_001)).toEqual([]);
  });

  it("sweep removes expired entries", () => {
    const t = new RoomCallPresenceTracker();
    t.applyBeacon(beacon("r1", "alice", 10_000));
    t.applyBeacon(beacon("r1", "bob", 20_000));
    t.sweep(15_000);
    expect(t.activeParticipants("r1", 15_000)).toEqual(["bob"]);
  });

  it("a leaving beacon removes the sender immediately", () => {
    const t = new RoomCallPresenceTracker();
    t.applyBeacon(beacon("r1", "alice", 10_000));
    t.applyBeacon(beacon("r1", "bob", 10_000));
    t.applyBeacon(beacon("r1", "alice", 0, [], true));
    expect(t.activeParticipants("r1", 5_000)).toEqual(["bob"]);
  });

  it("secondhand reports never shorten a firsthand lease", () => {
    const t = new RoomCallPresenceTracker();
    t.applyBeacon(beacon("r1", "bob", 30_000));
    // alice's beacon reports bob too, but with an older expiry
    t.applyBeacon(beacon("r1", "alice", 10_000, ["bob"]));
    expect(t.activeParticipants("r1", 20_000)).toEqual(["bob"]);
  });
});
