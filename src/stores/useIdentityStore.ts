import { create } from "zustand";
import type { Identity } from "../types/domain";
import * as identityService from "../services/identity/identity";
import * as identityRepo from "../services/db/identityRepo";

export type BootStatus =
  | "idle"
  | "loading"
  | "ready"
  | "needs-onboarding"
  | "error";

type IdentityState = {
  self: Identity | null;
  bootStatus: BootStatus;
  bootError: string | null;
  /** Set when onboarding is being shown because this device's identity key was
   * unrecoverable (keychain has no matching entry for a profile that still
   * exists locally) — surfaced so onboarding can explain why, instead of
   * silently looking like a first run. */
  bootNotice: string | null;
  /** Set when a keychain keypair exists but no SQLite profile row does yet
   * (e.g. the app crashed between keygen and profile creation) — onboarding
   * should skip straight to asking for a display name instead of regenerating a key. */
  pendingPublicKey: { identityId: string; publicKey: string } | null;

  loadIdentity: () => Promise<void>;
  createIdentity: (displayName: string) => Promise<void>;
  updateDisplayName: (displayName: string) => Promise<void>;
};

export const useIdentityStore = create<IdentityState>((set, get) => ({
  self: null,
  bootStatus: "idle",
  bootError: null,
  bootNotice: null,
  pendingPublicKey: null,

  loadIdentity: async () => {
    set({ bootStatus: "loading", bootError: null, bootNotice: null });
    try {
      const hasKey = await identityService.hasKeypair();
      const profile = await identityRepo.getIdentity();

      if (hasKey) {
        const pub = await identityService.getPublicKey();
        if (!pub) {
          throw new Error(
            "keychain reports a keypair but returned no public key",
          );
        }
        if (profile) {
          set({ self: profile, bootStatus: "ready" });
        } else {
          set({ bootStatus: "needs-onboarding", pendingPublicKey: pub });
        }
        return;
      }

      if (profile) {
        // The private key backing this profile is gone (keychain reset,
        // device migration, etc.) — this device can no longer act as that
        // identity, so the stale row would otherwise collide with the
        // singleton `identity` row once the user re-onboards.
        await identityRepo.deleteIdentity();
        set({
          bootStatus: "needs-onboarding",
          pendingPublicKey: null,
          bootNotice:
            "Your local identity key could not be found, so it couldn't be restored. You'll need a new invite to rejoin any trust group you were part of.",
        });
        return;
      }

      set({ bootStatus: "needs-onboarding", pendingPublicKey: null });
    } catch (err) {
      set({ bootStatus: "error", bootError: String(err) });
    }
  },

  createIdentity: async (displayName: string) => {
    const { pendingPublicKey } = get();
    const pub =
      pendingPublicKey ?? (await identityService.generateKeypair());

    const identity: Identity = {
      identityId: pub.identityId,
      publicKey: pub.publicKey,
      displayName,
      avatarPath: null,
      statusMessage: null,
      createdAt: Date.now(),
    };

    await identityRepo.createIdentity(identity);
    set({ self: identity, bootStatus: "ready", pendingPublicKey: null });
  },

  updateDisplayName: async (displayName: string) => {
    await identityRepo.updateDisplayName(displayName);
    set((state) => ({
      self: state.self ? { ...state.self, displayName } : state.self,
    }));
  },
}));
