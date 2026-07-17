import { describe, expect, it, vi } from "vitest";
import { Outbox } from "./Outbox";
import type { PeerRegistry } from "./PeerRegistry";
import type { HavenMessage } from "../../types/wire";

type ConnectedListener = (peerId: string) => void;

function fakeRegistry(initiallyConnected: boolean) {
  let connected = initiallyConnected;
  let onConnected: ConnectedListener = () => {};
  const sent: { peerId: string; payload: unknown }[] = [];
  const registry = {
    on: (event: string, listener: ConnectedListener) => {
      if (event === "peer-connected") onConnected = listener;
      return () => {};
    },
    send: (peerId: string, payload: unknown) => {
      if (!connected) return false;
      sent.push({ peerId, payload });
      return true;
    },
  } as unknown as PeerRegistry;
  return {
    registry,
    sent,
    setConnected: (v: boolean) => (connected = v),
    fireConnected: (peerId: string) => onConnected(peerId),
  };
}

const msg = (id: string): HavenMessage => ({
  type: "msg_ack",
  roomId: "r1",
  messageId: id,
});

describe("Outbox", () => {
  it("sends immediately when the peer is connected", () => {
    const f = fakeRegistry(true);
    const outbox = new Outbox(f.registry);
    expect(outbox.send("p1", msg("a"), 1000)).toBe(true);
    expect(f.sent).toHaveLength(1);
  });

  it("queues when disconnected and flushes in order on reconnect", () => {
    const f = fakeRegistry(false);
    const outbox = new Outbox(f.registry);
    expect(outbox.send("p1", msg("a"), 60_000)).toBe(false);
    expect(outbox.send("p1", msg("b"), 60_000)).toBe(false);
    expect(f.sent).toHaveLength(0);

    f.setConnected(true);
    f.fireConnected("p1");
    expect(f.sent.map((s) => (s.payload as { messageId: string }).messageId)).toEqual([
      "a",
      "b",
    ]);
  });

  it("drops expired items on flush and fires onExpired", () => {
    vi.useFakeTimers();
    const f = fakeRegistry(false);
    const outbox = new Outbox(f.registry);
    const expired = vi.fn();
    outbox.send("p1", msg("a"), 1_000, expired);
    outbox.send("p1", msg("b"), 60_000);

    vi.advanceTimersByTime(5_000);
    f.setConnected(true);
    f.fireConnected("p1");

    expect(expired).toHaveBeenCalledTimes(1);
    expect(f.sent).toHaveLength(1);
    expect((f.sent[0].payload as { messageId: string }).messageId).toBe("b");
    vi.useRealTimers();
  });

  it("sweep expires items without a reconnect", () => {
    vi.useFakeTimers();
    const f = fakeRegistry(false);
    const outbox = new Outbox(f.registry);
    const expired = vi.fn();
    outbox.send("p1", msg("a"), 1_000, expired);

    vi.advanceTimersByTime(5_000);
    outbox.sweep();
    expect(expired).toHaveBeenCalledTimes(1);

    // Nothing left to send after reconnect.
    f.setConnected(true);
    f.fireConnected("p1");
    expect(f.sent).toHaveLength(0);
    vi.useRealTimers();
  });

  it("requeues the remainder if the connection drops mid-flush", () => {
    const f = fakeRegistry(false);
    const outbox = new Outbox(f.registry);
    outbox.send("p1", msg("a"), 60_000);
    outbox.send("p1", msg("b"), 60_000);

    // Reconnect, but let only the first send succeed.
    let sends = 0;
    const origSend = f.registry.send.bind(f.registry);
    f.setConnected(true);
    (f.registry as { send: typeof f.registry.send }).send = (peerId, payload) => {
      sends++;
      if (sends > 1) return false;
      return origSend(peerId, payload);
    };
    f.fireConnected("p1");
    expect(f.sent).toHaveLength(1);

    // Second reconnect delivers the requeued item.
    (f.registry as { send: typeof f.registry.send }).send = origSend;
    f.fireConnected("p1");
    expect(f.sent.map((s) => (s.payload as { messageId: string }).messageId)).toEqual([
      "a",
      "b",
    ]);
  });
});
