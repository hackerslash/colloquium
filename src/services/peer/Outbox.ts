import type { ColloquiumMessage } from "../../types/wire";
import type { PeerRegistry } from "./PeerRegistry";

type QueuedItem = {
  payload: ColloquiumMessage;
  expiresAt: number;
  onExpired?: () => void;
};

/**
 * Tiny per-peer outbound queue for control messages that must survive a
 * closed connection (room announces/leaves, call invites). Items flush on
 * peer-connected and expire after their TTL. Chat messages don't ride this —
 * they're durable in SQLite and converge via room sync + acks.
 */
export class Outbox {
  private queues = new Map<string, QueuedItem[]>();

  constructor(private registry: PeerRegistry) {
    registry.on("peer-connected", (peerId) => this.flush(peerId));
  }

  /** Sends now if connected, else queues. Returns true if sent immediately. */
  send(peerId: string, payload: ColloquiumMessage, ttlMs: number, onExpired?: () => void): boolean {
    if (this.registry.send(peerId, payload)) return true;
    const queue = this.queues.get(peerId) ?? [];
    queue.push({ payload, expiresAt: Date.now() + ttlMs, onExpired });
    this.queues.set(peerId, queue);
    return false;
  }

  private flush(peerId: string) {
    const queue = this.queues.get(peerId);
    if (!queue) return;
    this.queues.delete(peerId);
    const now = Date.now();
    for (let i = 0; i < queue.length; i++) {
      const item = queue[i];
      if (now > item.expiresAt) {
        item.onExpired?.();
        continue;
      }
      if (!this.registry.send(peerId, item.payload)) {
        // Connection dropped again mid-flush — requeue the remainder.
        this.queues.set(peerId, queue.slice(i));
        return;
      }
    }
  }

  /** Drops expired items even if the peer never reconnects. Call periodically. */
  sweep(now = Date.now()) {
    for (const [peerId, queue] of this.queues) {
      const alive = queue.filter((item) => {
        if (now <= item.expiresAt) return true;
        item.onExpired?.();
        return false;
      });
      if (alive.length > 0) this.queues.set(peerId, alive);
      else this.queues.delete(peerId);
    }
  }
}
