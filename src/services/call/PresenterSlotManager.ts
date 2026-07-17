import type {
  PresenterSlotWire,
  SlotClaimMessage,
  SlotHeartbeatMessage,
  SlotReleaseMessage,
} from "../../types/wire";

export const SLOT_COUNT = 2;
export const LEASE_MS = 9_000;
export const HEARTBEAT_MS = 3_000;

type Slot = PresenterSlotWire;

function emptySlot(index: 0 | 1): Slot {
  return {
    slotIndex: index,
    holderId: null,
    epoch: 0,
    leaseExpiresAt: 0,
    mediaKind: null,
    streamId: null,
  };
}

/**
 * Coordinates the 2 presenter slots for a room call with no central arbiter.
 * Convergence rests on two order-independent rules:
 *   - A claim wins iff its epoch is higher, or equal-epoch with a
 *     lexicographically smaller claimantId (deterministic tie-break).
 *   - A slot is free to every observer once `now > leaseExpiresAt`, computed
 *     from the holder's last heartbeat's absolute expiry — so an abrupt
 *     disconnect frees the slot everywhere without any explicit message.
 * Every observer applies the same rules to the same messages and converges on
 * the same holders regardless of arrival order or dropped messages.
 */
export class PresenterSlotManager {
  private slots: [Slot, Slot] = [emptySlot(0), emptySlot(1)];

  snapshot(): Slot[] {
    return this.slots.map((s) => ({ ...s }));
  }

  /** Slots with expired holders reported as free, for querying/display. */
  effective(now: number): Slot[] {
    return this.slots.map((s) =>
      s.holderId && now > s.leaseExpiresAt
        ? { ...s, holderId: null, mediaKind: null, streamId: null }
        : { ...s },
    );
  }

  isFree(index: 0 | 1, now: number): boolean {
    const s = this.slots[index];
    return s.holderId === null || now > s.leaseExpiresAt;
  }

  holderOf(index: 0 | 1, now: number): string | null {
    return this.isFree(index, now) ? null : this.slots[index].holderId;
  }

  /** True if `identityId` currently presents in any slot. */
  slotHeldBy(identityId: string, now: number): 0 | 1 | null {
    for (const s of this.slots) {
      if (!this.isFree(s.slotIndex, now) && s.holderId === identityId) return s.slotIndex;
    }
    return null;
  }

  replaceAll(slots: PresenterSlotWire[]) {
    for (const incoming of slots) {
      const current = this.slots[incoming.slotIndex];
      if (incoming.epoch >= current.epoch) this.slots[incoming.slotIndex] = { ...incoming };
    }
  }

  /** Build the claim to broadcast; also applies it locally (optimistic).
   * Slots carry screen shares only; streamId is the sharer's screen
   * MediaStream id so receivers can classify incoming tracks. */
  buildClaim(
    index: 0 | 1,
    claimantId: string,
    streamId: string,
    now: number,
  ): SlotClaimMessage | null {
    if (!this.isFree(index, now)) return null;
    const epoch = this.slots[index].epoch + 1;
    const leaseExpiresAt = now + LEASE_MS;
    const claim: SlotClaimMessage = {
      type: "slot_claim",
      roomId: "", // filled in by caller (it owns the roomId)
      slotIndex: index,
      claimantId,
      epoch,
      leaseExpiresAt,
      mediaKind: "screen",
      streamId,
    };
    this.applyClaim(claim);
    return claim;
  }

  /** Returns true if the slot state changed. */
  applyClaim(msg: SlotClaimMessage): boolean {
    const current = this.slots[msg.slotIndex];
    const wins =
      msg.epoch > current.epoch ||
      (msg.epoch === current.epoch &&
        current.holderId !== null &&
        msg.claimantId < current.holderId);
    if (!wins) return false;
    this.slots[msg.slotIndex] = {
      slotIndex: msg.slotIndex,
      holderId: msg.claimantId,
      epoch: msg.epoch,
      leaseExpiresAt: msg.leaseExpiresAt,
      mediaKind: msg.mediaKind,
      streamId: msg.streamId,
    };
    return true;
  }

  applyHeartbeat(msg: SlotHeartbeatMessage): boolean {
    const current = this.slots[msg.slotIndex];
    if (msg.epoch < current.epoch) return false;
    this.slots[msg.slotIndex] = {
      slotIndex: msg.slotIndex,
      holderId: msg.holderId,
      epoch: msg.epoch,
      leaseExpiresAt: msg.leaseExpiresAt,
      mediaKind: msg.mediaKind,
      streamId: msg.streamId,
    };
    return true;
  }

  applyRelease(msg: SlotReleaseMessage): boolean {
    const current = this.slots[msg.slotIndex];
    // Bump epoch so any straggling heartbeat tagged with the old epoch loses.
    if (msg.epoch < current.epoch) return false;
    this.slots[msg.slotIndex] = {
      slotIndex: msg.slotIndex,
      holderId: null,
      epoch: msg.epoch + 1,
      leaseExpiresAt: 0,
      mediaKind: null,
      streamId: null,
    };
    return true;
  }

  buildHeartbeat(index: 0 | 1, holderId: string, now: number): SlotHeartbeatMessage | null {
    const s = this.slots[index];
    if (s.holderId !== holderId) return null;
    const leaseExpiresAt = now + LEASE_MS;
    s.leaseExpiresAt = leaseExpiresAt;
    return {
      type: "slot_heartbeat",
      roomId: "",
      slotIndex: index,
      holderId,
      epoch: s.epoch,
      leaseExpiresAt,
      mediaKind: s.mediaKind ?? "screen",
      streamId: s.streamId,
    };
  }

  buildRelease(index: 0 | 1, holderId: string): SlotReleaseMessage | null {
    const s = this.slots[index];
    if (s.holderId !== holderId) return null;
    const msg: SlotReleaseMessage = {
      type: "slot_release",
      roomId: "",
      slotIndex: index,
      holderId,
      epoch: s.epoch,
    };
    this.applyRelease(msg);
    return msg;
  }
}
