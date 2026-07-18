import { create } from "zustand";
import * as avatarRepo from "../services/db/avatarRepo";

type AvatarState = {
  /** identityId → object URL. `undefined` = not loaded, `null` = known-absent,
   * string = a live blob URL for the stored image. */
  urlById: Record<string, string | null>;
  loadAvatar: (identityId: string) => Promise<void>;
  applyAvatar: (
    identityId: string,
    rec: { mimeType: string; data: Uint8Array } | null,
  ) => void;
};

// Dedupes concurrent loads: many <Avatar>s for the same id mount at once, and
// we want a single SQLite read + object URL per id.
const inFlight = new Map<string, Promise<void>>();

function toObjectUrl(rec: { mimeType: string; data: Uint8Array }): string {
  return URL.createObjectURL(new Blob([rec.data], { type: rec.mimeType }));
}

export const useAvatarStore = create<AvatarState>((set, get) => ({
  urlById: {},

  loadAvatar: async (identityId: string) => {
    if (identityId in get().urlById) return;
    let pending = inFlight.get(identityId);
    if (!pending) {
      pending = (async () => {
        const rec = await avatarRepo.getAvatar(identityId);
        // A concurrent applyAvatar may have resolved it first; don't clobber.
        if (identityId in get().urlById) return;
        set((state) => ({
          urlById: { ...state.urlById, [identityId]: rec ? toObjectUrl(rec) : null },
        }));
      })().finally(() => inFlight.delete(identityId));
      inFlight.set(identityId, pending);
    }
    await pending;
  },

  applyAvatar: (identityId, rec) => {
    const prev = get().urlById[identityId];
    if (typeof prev === "string") URL.revokeObjectURL(prev);
    set((state) => ({
      urlById: { ...state.urlById, [identityId]: rec ? toObjectUrl(rec) : null },
    }));
  },
}));
