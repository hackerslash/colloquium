import { describe, expect, it } from "vitest";
import type { Message } from "../types/domain";
import { buildTranscript } from "./exportTranscript";

const AT = Date.UTC(2026, 0, 15, 12, 0, 0);

function msg(over: Partial<Message>): Message {
  return {
    id: "m1",
    roomId: "grp_1",
    authorId: "alice",
    authorSeq: 1,
    hlc: "1",
    contentType: "text",
    body: "hello",
    replyToId: null,
    sentAt: AT,
    editedAt: null,
    deletedAt: null,
    sig: "sig",
    deliveryStatus: "delivered",
    readAt: null,
    ...over,
  };
}

const nameOf = (id: string) => (id === "alice" ? "Alice" : "Bob");

describe("buildTranscript", () => {
  it("humanizes mention and animated-emoji tokens", () => {
    const out = buildTranscript(
      "Room",
      [msg({ body: "hey @[Bob](bob-identity-id) :fx:tada:" })],
      nameOf,
      AT,
    );
    expect(out).toContain("hey @Bob [Party Popper]");
    expect(out).not.toContain(":fx:");
    expect(out).not.toContain("](");
  });

  it("keeps a tombstone as a placeholder instead of dropping it", () => {
    const out = buildTranscript("Room", [msg({ body: null, deletedAt: AT })], nameOf, AT);
    expect(out).toContain("*message deleted*");
  });

  it("marks an edited message", () => {
    const out = buildTranscript("Room", [msg({ editedAt: AT + 1 })], nameOf, AT);
    expect(out).toContain("(edited)");
  });

  it("notes an attachment by name", () => {
    const out = buildTranscript(
      "Room",
      [msg({ body: null, contentType: "file", attachmentName: "notes.pdf" })],
      nameOf,
      AT,
    );
    expect(out).toContain("notes.pdf");
  });

  it("emits one day heading per day, not per message", () => {
    const day = 24 * 60 * 60 * 1000;
    const out = buildTranscript(
      "Room",
      [msg({ id: "a" }), msg({ id: "b" }), msg({ id: "c", sentAt: AT + day })],
      nameOf,
      AT,
    );
    expect(out.match(/^## /gm)).toHaveLength(2);
  });

  it("says so rather than emitting an empty document", () => {
    expect(buildTranscript("Room", [], nameOf, AT)).toContain("*No messages.*");
  });
});
