import { create } from "zustand";
import type { Room } from "../types/domain";
import * as roomRepo from "../services/db/roomRepo";
import * as readStateRepo from "../services/db/readStateRepo";
import * as muteRepo from "../services/db/muteRepo";
import * as chatService from "../services/room/chatService";
import { useIdentityStore } from "./useIdentityStore";
import { setAppBadge } from "../services/badge";
import { toast } from "./useToastStore";

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
  /** Rooms the user has muted, keyed by room id (value always true). Muted
   * rooms keep their unread count but are excluded from the dock badge/title
   * and never notify unless a message mentions the user. */
  mutedByRoom: Record<string, true>;
  /** Captured when a room becomes active, before markRead clears unreadByRoom */
  roomSessionState: Record<string, { initialUnread: number; lastReadAt: number }>;

  loadRooms: () => Promise<void>;
  loadUnread: () => Promise<void>;
  loadMuted: () => Promise<void>;
  toggleMute: (roomId: string) => Promise<void>;
  markRead: (roomId: string) => Promise<void>;
  bumpUnread: (roomId: string, by?: number) => void;
  setActiveRoom: (id: string | null) => void;
  _setRoomCallActivity: (map: Record<string, string[]>) => void;
};

/** Sum of unread counts, excluding muted rooms — the dock badge and window
 * title reflect only rooms that can actively grab attention. */
function totalUnread(map: Record<string, number>, muted: Record<string, true>): number {
  return Object.entries(map).reduce((sum, [roomId, n]) => (muted[roomId] ? sum : sum + n), 0);
}

function refreshAppBadge(map: Record<string, number>, muted: Record<string, true>) {
  const total = totalUnread(map, muted);
  document.title = total > 0 ? `Colloquium (${total})` : "Colloquium";
  void setAppBadge(total);
}

export const useRoomStore = create<RoomState>((set, get) => ({
  roomsById: {},
  activeRoomId: null,
  callParticipantsByRoom: {},
  unreadByRoom: {},
  lastReadAtByRoom: {},
  mutedByRoom: {},
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
    refreshAppBadge(map, get().mutedByRoom);
  },

  loadMuted: async () => {
    const muted = await muteRepo.listMuted();
    const map = Object.fromEntries([...muted].map((id) => [id, true as const]));
    set({ mutedByRoom: map });
    refreshAppBadge(get().unreadByRoom, map);
  },

  toggleMute: async (roomId) => {
    const wasMuted = !!get().mutedByRoom[roomId];
    const apply = (muted: boolean) => {
      const next = { ...get().mutedByRoom };
      if (muted) next[roomId] = true;
      else delete next[roomId];
      set({ mutedByRoom: next });
      refreshAppBadge(get().unreadByRoom, next);
    };
    apply(!wasMuted); // optimistic
    try {
      if (wasMuted) await muteRepo.unmute(roomId);
      else await muteRepo.mute(roomId, Date.now());
    } catch (err) {
      console.error("failed to toggle mute", roomId, err);
      apply(wasMuted); // rollback
      toast.error("Couldn't update mute setting", "Please try again.");
    }
  },

  markRead: async (roomId) => {
    const now = Date.now();
    await readStateRepo.markRead(roomId, now);
    const self = useIdentityStore.getState().self;
    if (self) {
      void chatService
        .sendReadReceipt(self.identityId, roomId)
        .catch((err) => console.error("failed to send read receipt", roomId, err));
    }
    set((s) => {
      const nextLastRead = { ...s.lastReadAtByRoom, [roomId]: now };
      if (!s.unreadByRoom[roomId]) return { lastReadAtByRoom: nextLastRead };
      const nextUnread = { ...s.unreadByRoom };
      delete nextUnread[roomId];
      refreshAppBadge(nextUnread, s.mutedByRoom);
      return { unreadByRoom: nextUnread, lastReadAtByRoom: nextLastRead };
    });
  },

  bumpUnread: (roomId, by = 1) =>
    set((s) => {
      const next = { ...s.unreadByRoom, [roomId]: (s.unreadByRoom[roomId] ?? 0) + by };
      refreshAppBadge(next, s.mutedByRoom);
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
