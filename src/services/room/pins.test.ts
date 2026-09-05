import { beforeEach, describe, expect, it, vi } from "vitest";

// Same isolation as editDelete.test.ts: stub everything chatService imports
// that would reach the DB or the peer registry.
vi.mock("../db/messageRepo", () => ({ latestHlc: vi.fn().mockResolvedValue(null) }));
vi.mock("../db/rosterRepo", () => ({ getContact: vi.fn() }));
vi.mock("../db/fileRepo", () => ({}));
vi.mock("../db/reactionRepo", () => ({}));
vi.mock("../db/roomRepo", () => ({}));
vi.mock("../db/pinRepo", () => ({ add: vi.fn(), remove: vi.fn() }));
vi.mock("../identity/identity", () => ({ verify: vi.fn(), sign: vi.fn() }));
vi.mock("../peer/registry", () => ({
  getPeerRegistry: () => ({ send: () => false }),
  getOutbox: () => ({}),
}));

import * as pinRepo from "../db/pinRepo";
import { dmRoomId, handlePin } from "./chatService";

const SELF = "self".padEnd(64, "0");
const SENDER = "sender".padEnd(64, "a");
const THIRD = "third".padEnd(64, "b");

beforeEach(() => vi.clearAllMocks());

describe("handlePin", () => {
  it("attributes the pin to the authenticated sender", async () => {
    const out = await handlePin(SELF, SENDER, {
      type: "pin",
      roomId: "room1",
      messageId: "m1",
      op: "add",
      pinnedAt: 2000,
    });
    expect(out?.authorId).toBe(SENDER);
    expect(pinRepo.add).toHaveBeenCalledWith({
      messageId: "m1",
      roomId: "room1",
      authorId: SENDER,
      pinnedAt: 2000,
    });
  });

  it("accepts a pin in the sender's own DM room", async () => {
    const roomId = await dmRoomId(SELF, SENDER);
    const out = await handlePin(SELF, SENDER, {
      type: "pin",
      roomId,
      messageId: "m1",
      op: "add",
      pinnedAt: 2000,
    });
    expect(out).not.toBeNull();
    expect(pinRepo.add).toHaveBeenCalled();
  });

  it("rejects a pin injected into our DM with a third party", async () => {
    const otherDm = await dmRoomId(SELF, THIRD);
    const out = await handlePin(SELF, SENDER, {
      type: "pin",
      roomId: otherDm,
      messageId: "m1",
      op: "add",
      pinnedAt: 2000,
    });
    expect(out).toBeNull();
    expect(pinRepo.add).not.toHaveBeenCalled();
  });

  it("removes only the sender's own pin row, never another author's", async () => {
    await handlePin(SELF, SENDER, {
      type: "pin",
      roomId: "room1",
      messageId: "m1",
      op: "remove",
      pinnedAt: 3000,
    });
    expect(pinRepo.remove).toHaveBeenCalledWith("m1", SENDER);
    expect(pinRepo.add).not.toHaveBeenCalled();
  });

  it("ignores a pin with no messageId", async () => {
    const out = await handlePin(SELF, SENDER, {
      type: "pin",
      roomId: "room1",
      messageId: "",
      op: "add",
      pinnedAt: 2000,
    });
    expect(out).toBeNull();
    expect(pinRepo.add).not.toHaveBeenCalled();
  });
});
