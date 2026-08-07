import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../types/domain";

const requestAttachment = vi.fn();
vi.mock("../services/room/chatService", () => ({
  requestAttachment: (m: Message) => requestAttachment(m),
}));

import { fetchAttachment } from "./fetchAttachment";
import { useToastStore } from "../stores/useToastStore";

function msg(): Message {
  return {
    id: "m1",
    roomId: "grp_1",
    authorId: "alice",
    authorSeq: 1,
    hlc: "1",
    contentType: "file",
    body: null,
    attachmentId: "f1",
    attachmentName: "notes.pdf",
    replyToId: null,
    sentAt: 0,
    editedAt: null,
    deletedAt: null,
    sig: "sig",
    deliveryStatus: "delivered",
    readAt: null,
  };
}

function emit(type: string, detail: unknown) {
  window.dispatchEvent(new CustomEvent(type, { detail }));
}

const only = () => useToastStore.getState().toasts[0];

beforeEach(() => {
  vi.stubGlobal("window", new EventTarget());
  vi.useFakeTimers();
  requestAttachment.mockReturnValue(true);
  useToastStore.setState({ toasts: [] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("fetchAttachment", () => {
  it("tracks progress and settles on success", async () => {
    const done = fetchAttachment(msg());
    expect(only().progress).toBeNull(); // busy, no percentage yet

    emit("colloquium_file_progress", { fileId: "f1", received: 1, expected: 4 });
    expect(only().progress).toBe(25);

    emit("colloquium_file_downloaded", "f1");
    expect(await done).toBe(true);
    // progress cleared, so the toast becomes auto-dismissable again
    expect(only()).toMatchObject({ variant: "success", progress: undefined });
  });

  it("ignores events for other files", async () => {
    const done = fetchAttachment(msg());
    emit("colloquium_file_progress", { fileId: "other", received: 3, expected: 4 });
    emit("colloquium_file_downloaded", "other");
    expect(only().progress).toBeNull();

    // still listening for its own file
    emit("colloquium_file_downloaded", "f1");
    expect(await done).toBe(true);
  });

  it("fails when the transfer stalls", async () => {
    const done = fetchAttachment(msg());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await done).toBe(false);
    expect(only().variant).toBe("error");
  });

  it("keeps waiting while chunks are still arriving", async () => {
    const done = fetchAttachment(msg());
    for (let i = 1; i <= 4; i++) {
      await vi.advanceTimersByTimeAsync(20_000);
      emit("colloquium_file_progress", { fileId: "f1", received: i, expected: 5 });
    }
    // 80s in and still alive, because each chunk re-armed the stall timer
    expect(only().progress).toBe(80);
    emit("colloquium_file_downloaded", "f1");
    expect(await done).toBe(true);
  });

  it("does not open a busy toast when the sender is offline", async () => {
    requestAttachment.mockReturnValue(false);
    expect(await fetchAttachment(msg())).toBe(false);
    expect(only().variant).toBe("info");
    expect(only().progress).toBeUndefined();
  });
});
