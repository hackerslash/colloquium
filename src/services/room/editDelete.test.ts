import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock every module chatService pulls in that would otherwise reach the DB or
// the peer registry, so we can exercise the handleEdit/handleDelete guards in
// isolation.
vi.mock("../db/messageRepo", () => ({
  getById: vi.fn(),
  applyEdit: vi.fn(),
  applyDelete: vi.fn(),
  latestHlc: vi.fn().mockResolvedValue(null),
}));
vi.mock("../db/rosterRepo", () => ({ getContact: vi.fn() }));
vi.mock("../db/fileRepo", () => ({ deleteFile: vi.fn() }));
vi.mock("../db/reactionRepo", () => ({}));
vi.mock("../db/pinRepo", () => ({}));
vi.mock("../db/roomRepo", () => ({}));
vi.mock("../identity/identity", () => ({ verify: vi.fn(), sign: vi.fn() }));
vi.mock("../peer/registry", () => ({
  getPeerRegistry: () => ({ send: () => false }),
  getOutbox: () => ({}),
}));

import * as messageRepo from "../db/messageRepo";
import * as rosterRepo from "../db/rosterRepo";
import * as identityService from "../identity/identity";
import { handleDelete, handleEdit } from "./chatService";
import type { Message } from "../../types/domain";

const SELF = { identityId: "self".padEnd(64, "0"), displayName: "Me", publicKey: "selfpk" } as any;
const AUTHOR = "author".padEnd(64, "a");

function baseMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "m1",
    roomId: "room1", // not a dm_ room, so the DM guard is skipped
    authorId: AUTHOR,
    authorSeq: 1,
    hlc: "hlc1",
    contentType: "text",
    body: "original",
    replyToId: null,
    sentAt: 1000,
    editedAt: null,
    deletedAt: null,
    sig: "oldsig",
    deliveryStatus: "delivered",
    readAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (rosterRepo.getContact as any).mockResolvedValue({ identityId: AUTHOR, publicKey: "authorpk" });
  (identityService.verify as any).mockResolvedValue(true);
  (messageRepo.applyEdit as any).mockResolvedValue(true);
  (messageRepo.applyDelete as any).mockResolvedValue(true);
});

describe("handleEdit", () => {
  it("applies a valid signed edit from the message author", async () => {
    (messageRepo.getById as any).mockResolvedValue(baseMessage());
    const out = await handleEdit(SELF, AUTHOR, {
      type: "msg_edit",
      roomId: "room1",
      messageId: "m1",
      body: "edited",
      editedAt: 2000,
      sig: "newsig",
    });
    expect(out?.body).toBe("edited");
    expect(out?.editedAt).toBe(2000);
    expect(out?.sig).toBe("newsig");
    expect(messageRepo.applyEdit).toHaveBeenCalledWith("m1", "edited", 2000, "newsig");
  });

  it("rejects an edit from someone other than the author", async () => {
    (messageRepo.getById as any).mockResolvedValue(baseMessage());
    const out = await handleEdit(SELF, "imposter".padEnd(64, "b"), {
      type: "msg_edit",
      roomId: "room1",
      messageId: "m1",
      body: "edited",
      editedAt: 2000,
      sig: "newsig",
    });
    expect(out).toBeNull();
    expect(messageRepo.applyEdit).not.toHaveBeenCalled();
  });

  it("rejects a stale (non-monotonic) editedAt", async () => {
    (messageRepo.getById as any).mockResolvedValue(baseMessage({ editedAt: 5000 }));
    const out = await handleEdit(SELF, AUTHOR, {
      type: "msg_edit",
      roomId: "room1",
      messageId: "m1",
      body: "edited",
      editedAt: 4000,
      sig: "newsig",
    });
    expect(out).toBeNull();
    expect(messageRepo.applyEdit).not.toHaveBeenCalled();
  });

  it("refuses to edit a deleted message", async () => {
    (messageRepo.getById as any).mockResolvedValue(baseMessage({ deletedAt: 1500, body: null }));
    const out = await handleEdit(SELF, AUTHOR, {
      type: "msg_edit",
      roomId: "room1",
      messageId: "m1",
      body: "edited",
      editedAt: 2000,
      sig: "newsig",
    });
    expect(out).toBeNull();
  });

  it("rejects an edit whose signature does not verify", async () => {
    (messageRepo.getById as any).mockResolvedValue(baseMessage());
    (identityService.verify as any).mockResolvedValue(false);
    const out = await handleEdit(SELF, AUTHOR, {
      type: "msg_edit",
      roomId: "room1",
      messageId: "m1",
      body: "edited",
      editedAt: 2000,
      sig: "forged",
    });
    expect(out).toBeNull();
    expect(messageRepo.applyEdit).not.toHaveBeenCalled();
  });

  it("ignores an edit for a message not held locally (converges via sync)", async () => {
    (messageRepo.getById as any).mockResolvedValue(null);
    const out = await handleEdit(SELF, AUTHOR, {
      type: "msg_edit",
      roomId: "room1",
      messageId: "m1",
      body: "edited",
      editedAt: 2000,
      sig: "newsig",
    });
    expect(out).toBeNull();
  });
});

describe("handleDelete", () => {
  it("tombstones a valid signed delete from the author", async () => {
    (messageRepo.getById as any).mockResolvedValue(baseMessage());
    const out = await handleDelete(SELF, AUTHOR, {
      type: "msg_delete",
      roomId: "room1",
      messageId: "m1",
      deletedAt: 2000,
      sig: "delsig",
    });
    expect(out?.deletedAt).toBe(2000);
    expect(out?.body).toBeNull();
    expect(messageRepo.applyDelete).toHaveBeenCalledWith("m1", 2000, "delsig");
  });

  it("rejects a delete from a non-author", async () => {
    (messageRepo.getById as any).mockResolvedValue(baseMessage());
    const out = await handleDelete(SELF, "imposter".padEnd(64, "b"), {
      type: "msg_delete",
      roomId: "room1",
      messageId: "m1",
      deletedAt: 2000,
      sig: "delsig",
    });
    expect(out).toBeNull();
    expect(messageRepo.applyDelete).not.toHaveBeenCalled();
  });

  it("is idempotent — a second delete is a no-op", async () => {
    (messageRepo.getById as any).mockResolvedValue(baseMessage({ deletedAt: 1500, body: null }));
    const out = await handleDelete(SELF, AUTHOR, {
      type: "msg_delete",
      roomId: "room1",
      messageId: "m1",
      deletedAt: 2000,
      sig: "delsig",
    });
    expect(out).toBeNull();
    expect(messageRepo.applyDelete).not.toHaveBeenCalled();
  });
});
