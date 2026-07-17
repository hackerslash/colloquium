import { create } from "zustand";
import type { Room } from "../types/domain";
import * as roomRepo from "../services/db/roomRepo";
import * as readStateRepo from "../services/db/readStateRepo";
import { useIdentityStore } from "./useIdentityStore";

type RoomState = {
  roomsById: Record<string, Room>;
  activeRoomId: string | null;
  /** Who is currently in each room's call (lease-tracked from beacons) —
   * empty/absent means the room has no active call. */
  callParticipantsByRoom: Record<string, string[]>;
  /** Unread message counts per room, keyed by room id. */
  unreadByRoom: Record<string, number>;

  loadRooms: () => Promise<void>;
  loadUnread: () => Promise<void>;
  markRead: (roomId: string) => Promise<void>;
  bumpUnread: (roomId: string) => void;
  setActiveRoom: (id: string | null) => void;
  upsertRoomLocal: (room: Room) => void;
  _setRoomCallActivity: (map: Record<string, string[]>) => void;
};

function totalUnread(map: Record<string, number>): number {
  return Object.values(map).reduce((sum, n) => sum + n, 0);
}

function refreshAppBadge(map: Record<string, number>) {
  const total = totalUnread(map);
  document.title = total > 0 ? `Haven (${total})` : "Haven";
}

export const useRoomStore = create<RoomState>((set, get) => ({
  roomsById: {},
  activeRoomId: null,
  callParticipantsByRoom: {},
  unreadByRoom: {},

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
    set({ unreadByRoom: map });
    refreshAppBadge(map);
  },

  markRead: async (roomId) => {
    await readStateRepo.markRead(roomId, Date.now());
    set((s) => {
      if (!s.unreadByRoom[roomId]) return s;
      const next = { ...s.unreadByRoom };
      delete next[roomId];
      refreshAppBadge(next);
      return { unreadByRoom: next };
    });
  },

  bumpUnread: (roomId) =>
    set((s) => {
      const next = { ...s.unreadByRoom, [roomId]: (s.unreadByRoom[roomId] ?? 0) + 1 };
      refreshAppBadge(next);
      return { unreadByRoom: next };
    }),

  setActiveRoom: (id) => {
    set({ activeRoomId: id });
    if (id) void get().markRead(id);
  },

  upsertRoomLocal: (room) =>
    set((state) => ({ roomsById: { ...state.roomsById, [room.id]: room } })),

  _setRoomCallActivity: (map) => set({ callParticipantsByRoom: map }),
}));
