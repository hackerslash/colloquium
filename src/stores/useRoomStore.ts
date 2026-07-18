import { create } from "zustand";
import type { Room } from "../types/domain";
import * as roomRepo from "../services/db/roomRepo";
import * as readStateRepo from "../services/db/readStateRepo";
import { useIdentityStore } from "./useIdentityStore";
import { setAppBadge } from "../services/badge";

type RoomState = {
  roomsById: Record<string, Room>;
  activeRoomId: string | null;
  /** Who is currently in each room's call (lease-tracked from beacons) —
   * empty/absent means the room has no active call. */
  callParticipantsByRoom: Record<string, string[]>;
  /** Unread message counts per room, keyed by room id. */
  unreadByRoom: Record<string, number>;
  /** Last read timestamp per room, keyed by room id. */
  lastReadAtByRoom: Record<string, number>;
  /** Captured when a room becomes active, before markRead clears unreadByRoom */
  roomSessionState: Record<string, { initialUnread: number; lastReadAt: number }>;

  loadRooms: () => Promise<void>;
  loadUnread: () => Promise<void>;
  markRead: (roomId: string) => Promise<void>;
  bumpUnread: (roomId: string, by?: number) => void;
  setActiveRoom: (id: string | null) => void;
  _setRoomCallActivity: (map: Record<string, string[]>) => void;
};

function totalUnread(map: Record<string, number>): number {
  return Object.values(map).reduce((sum, n) => sum + n, 0);
}

function refreshAppBadge(map: Record<string, number>) {
  const total = totalUnread(map);
  document.title = total > 0 ? `Haven (${total})` : "Haven";
  void setAppBadge(total);
}

export const useRoomStore = create<RoomState>((set, get) => ({
  roomsById: {},
  activeRoomId: null,
  callParticipantsByRoom: {},
  unreadByRoom: {},
  lastReadAtByRoom: {},
  roomSessionState: {},

  loadRooms: async () => {
    const self = useIdentityStore.getState().self;
    if (!self) return;
    const rooms = await roomRepo.listRooms(self.identityId);
    set({ roomsById: Object.fromEntries(rooms.map((r) => [r.id, r])) });
  },

  loadUnread: async () => {
    const self = useIdentityStore.getState().self;
    if (!self) return;
    // First run after the read-state migration: treat all history as read so
    // every room doesn't light up 99+.
    if (await readStateRepo.isEmpty()) await readStateRepo.seedAll(Date.now());
    const map = await readStateRepo.unreadCounts(self.identityId);
    const lastReadMap = await readStateRepo.lastReadTimes();
    set({ unreadByRoom: map, lastReadAtByRoom: lastReadMap });
    refreshAppBadge(map);
  },

  markRead: async (roomId) => {
    const now = Date.now();
    await readStateRepo.markRead(roomId, now);
    set((s) => {
      const nextLastRead = { ...s.lastReadAtByRoom, [roomId]: now };
      if (!s.unreadByRoom[roomId]) return { lastReadAtByRoom: nextLastRead };
      const nextUnread = { ...s.unreadByRoom };
      delete nextUnread[roomId];
      refreshAppBadge(nextUnread);
      return { unreadByRoom: nextUnread, lastReadAtByRoom: nextLastRead };
    });
  },

  bumpUnread: (roomId, by = 1) =>
    set((s) => {
      const next = { ...s.unreadByRoom, [roomId]: (s.unreadByRoom[roomId] ?? 0) + by };
      refreshAppBadge(next);
      return { unreadByRoom: next };
    }),

  setActiveRoom: (id) => {
    if (id) {
      const unread = get().unreadByRoom[id] ?? 0;
      const lastReadAt = get().lastReadAtByRoom[id] ?? 0;
      set((s) => ({
        activeRoomId: id,
        roomSessionState: {
          ...s.roomSessionState,
          [id]: s.roomSessionState[id] ?? { initialUnread: unread, lastReadAt },
        },
      }));
      void get().markRead(id);
    } else {
      set({ activeRoomId: null });
    }
  },

  _setRoomCallActivity: (map) => set({ callParticipantsByRoom: map }),
}));
