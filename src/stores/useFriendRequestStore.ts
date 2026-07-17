import { create } from "zustand";
import * as friendRequestsRepo from "../services/db/friendRequestsRepo";

type FriendRequestState = {
  /** Pending incoming requests, newest first. Drives the Inbox list and the
   * sidebar's pending badge, so both stay in sync as requests arrive/resolve. */
  pending: friendRequestsRepo.FriendRequest[];
  refresh: () => Promise<void>;
};

export const useFriendRequestStore = create<FriendRequestState>((set) => ({
  pending: [],
  refresh: async () => {
    const pending = await friendRequestsRepo.listPendingIncoming();
    set({ pending });
  },
}));
