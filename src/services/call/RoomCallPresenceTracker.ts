import type { RoomCallBeaconMessage } from "../../types/wire";
import { useRoomStore } from "../../stores/useRoomStore";

/**
 * Tracks who is in each room's call from `room_call_beacon` messages —
 * received by ALL room members, in-call or not, so a room can show as active
 * to people who haven't joined. Same absolute-expiry lease model as
 * PresenterSlotManager: an entry with no fresh beacon expires on its own,
 * which handles abrupt disconnects with no explicit leave.
 */
export class RoomCallPresenceTracker {
  /** roomId → (identityId → leaseExpiresAt) */
  private byRoom = new Map<string, Map<string, number>>();

  applyBeacon(msg: RoomCallBeaconMessage) {
    const room = this.byRoom.get(msg.roomId) ?? new Map<string, number>();
    if (msg.leaving) {
      room.delete(msg.fromId);
    } else {
      room.set(msg.fromId, Math.max(room.get(msg.fromId) ?? 0, msg.leaseExpiresAt));
      // The sender's view of other participants is secondary evidence — it
      // never shortens a lease we learned firsthand.
      for (const participant of msg.participants) {
        room.set(participant, Math.max(room.get(participant) ?? 0, msg.leaseExpiresAt));
      }
    }
    if (room.size > 0) this.byRoom.set(msg.roomId, room);
    else this.byRoom.delete(msg.roomId);
    this.push();
  }

  /** Expires stale leases. Call periodically (the discovery tick). */
  sweep(now = Date.now()) {
    let changed = false;
    for (const [roomId, room] of this.byRoom) {
      for (const [id, expiresAt] of room) {
        if (expiresAt <= now) {
          room.delete(id);
          changed = true;
        }
      }
      if (room.size === 0) this.byRoom.delete(roomId);
    }
    if (changed) this.push();
  }

  activeParticipants(roomId: string, now = Date.now()): string[] {
    const room = this.byRoom.get(roomId);
    if (!room) return [];
    return [...room.entries()].filter(([, exp]) => exp > now).map(([id]) => id);
  }

  private push() {
    const map: Record<string, string[]> = {};
    for (const [roomId, room] of this.byRoom) {
      map[roomId] = [...room.keys()];
    }
    useRoomStore.getState()._setRoomCallActivity(map);
  }
}

let tracker: RoomCallPresenceTracker | null = null;

export function getRoomCallPresenceTracker(): RoomCallPresenceTracker {
  if (!tracker) tracker = new RoomCallPresenceTracker();
  return tracker;
}
