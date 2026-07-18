import { create } from "zustand";
import type { Presence, RosterContact } from "../types/domain";
import * as rosterRepo from "../services/db/rosterRepo";
import * as rosterService from "../services/roster/rosterService";
import { dmRoomId } from "../services/room/chatService";
import { useIdentityStore } from "./useIdentityStore";

type RosterState = {
  contactsById: Record<string, RosterContact>;
  presenceById: Record<string, Presence>;
  /** contactId → deterministic DM room id, for sidebar unread badges (the
   * room id is an async SHA-256, so it's precomputed once per roster load). */
  dmRoomIdByContact: Record<string, string>;

  loadRoster: () => Promise<void>;
  createInvite: () => Promise<string>;
  acceptInvite: (inviteString: string) => Promise<void>;
  removeContact: (contactId: string) => Promise<void>;
  setPresence: (identityId: string, presence: Presence) => void;
  noteSeen: (identityId: string, seenAt: number) => void;
};

// A DM room id is a stable SHA-256 of the two identity ids, so cache it per
// contact — loadRoster runs on every incoming roster_sync, and recomputing a
// digest for every contact each time is pure waste.
const dmRoomIdCache = new Map<string, string>();

async function buildDmRoomMap(contacts: RosterContact[]): Promise<Record<string, string>> {
  const selfId = useIdentityStore.getState().self?.identityId;
  if (!selfId) return {};
  const entries = await Promise.all(
    contacts.map(async (c) => {
      let roomId = dmRoomIdCache.get(c.identityId);
      if (!roomId) {
        roomId = await dmRoomId(selfId, c.identityId);
        dmRoomIdCache.set(c.identityId, roomId);
      }
      return [c.identityId, roomId] as const;
    }),
  );
  return Object.fromEntries(entries);
}

function requireSelf() {
  const self = useIdentityStore.getState().self;
  if (!self) throw new Error("no local identity yet");
  return self;
}

/** Loads contacts, defensively dropping any row matching our own identity —
 * and cleaning it out of SQLite if found, to repair databases written before
 * the roster-merge self-filter existed. */
async function loadContactsExcludingSelf(): Promise<RosterContact[]> {
  const selfId = useIdentityStore.getState().self?.identityId;
  const contacts = await rosterRepo.listContacts();
  if (selfId && contacts.some((c) => c.identityId === selfId)) {
    await rosterRepo.deleteContact(selfId);
    return contacts.filter((c) => c.identityId !== selfId);
  }
  return contacts;
}

export const useRosterStore = create<RosterState>((set, get) => ({
  contactsById: {},
  presenceById: {},
  dmRoomIdByContact: {},

  loadRoster: async () => {
    const contacts = await loadContactsExcludingSelf();
    set({
      contactsById: Object.fromEntries(contacts.map((c) => [c.identityId, c])),
      dmRoomIdByContact: await buildDmRoomMap(contacts),
    });
  },

  createInvite: async () => {
    return rosterService.createInvite(requireSelf());
  },

  acceptInvite: async (inviteString: string) => {
    await rosterService.acceptInvite(requireSelf(), inviteString);
    await get().loadRoster();
  },

  removeContact: async (contactId: string) => {
    await rosterService.removeContact(requireSelf(), contactId);
    dmRoomIdCache.delete(contactId);
    await get().loadRoster();
  },

  setPresence: (identityId: string, presence: Presence) => {
    // The 2s discovery tick sets presence for every contact each pass; skip the
    // state clone (and the re-render it triggers) when nothing actually changed.
    if (get().presenceById[identityId] === presence) return;
    set((state) => ({
      presenceById: { ...state.presenceById, [identityId]: presence },
    }));
  },

  // Bumps a contact's persisted lastSeenAt in the store so the UI updates live,
  // without the full-roster SQLite re-read loadRoster does.
  noteSeen: (identityId: string, seenAt: number) => {
    const contact = get().contactsById[identityId];
    if (!contact) return;
    set((state) => ({
      contactsById: {
        ...state.contactsById,
        [identityId]: { ...contact, lastSeenAt: seenAt },
      },
    }));
  },
}));
