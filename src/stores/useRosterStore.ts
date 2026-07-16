import { create } from "zustand";
import type { Presence, RosterContact } from "../types/domain";
import * as rosterRepo from "../services/db/rosterRepo";
import * as rosterService from "../services/roster/rosterService";
import { useIdentityStore } from "./useIdentityStore";

type RosterState = {
  contactsById: Record<string, RosterContact>;
  presenceById: Record<string, Presence>;

  loadRoster: () => Promise<void>;
  createInvite: () => Promise<string>;
  acceptInvite: (inviteString: string) => Promise<void>;
  setPresence: (identityId: string, presence: Presence) => void;
};

function requireSelf() {
  const self = useIdentityStore.getState().self;
  if (!self) throw new Error("no local identity yet");
  return self;
}

export const useRosterStore = create<RosterState>((set) => ({
  contactsById: {},
  presenceById: {},

  loadRoster: async () => {
    const contacts = await rosterRepo.listContacts();
    set({
      contactsById: Object.fromEntries(contacts.map((c) => [c.identityId, c])),
    });
  },

  createInvite: async () => {
    return rosterService.createInvite(requireSelf());
  },

  acceptInvite: async (inviteString: string) => {
    await rosterService.acceptInvite(requireSelf(), inviteString);
    const contacts = await rosterRepo.listContacts();
    set({
      contactsById: Object.fromEntries(contacts.map((c) => [c.identityId, c])),
    });
  },

  setPresence: (identityId: string, presence: Presence) => {
    set((state) => ({
      presenceById: { ...state.presenceById, [identityId]: presence },
    }));
  },
}));
