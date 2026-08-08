import { describe, it, expect } from "vitest";
import { matchDialingPeer } from "./PeerRegistry";

describe("matchDialingPeer", () => {
  it("finds the dialed peer named in a peer-unavailable message", () => {
    const msg = "Could not connect to peer colloquium-9f3a1b2c";
    expect(matchDialingPeer(msg, ["colloquium-9f3a1b2c", "colloquium-other"])).toBe(
      "colloquium-9f3a1b2c",
    );
  });

  it("returns null when no candidate appears in the message", () => {
    expect(matchDialingPeer("Could not connect to peer someone-else", ["colloquium-x"])).toBeNull();
  });

  it("ignores empty candidate ids", () => {
    expect(matchDialingPeer("Could not connect to peer ", ["", "colloquium-x"])).toBeNull();
  });
});
