import { create } from "zustand";
import type { Identity } from "../types/domain";
import type { AudioTrackId, PlayerMode, SubTrackId, TrackInfo } from "../services/watchparty/watchPartyPlayer";
import * as watchPartyService from "../services/watchparty/watchPartyService";
import { useIdentityStore } from "./useIdentityStore";
import { toast } from "./useToastStore";

export type WatchPartyMember = { id: string; ready: boolean; bufferedSec: number };
export type AnnouncedParty = { partyId: string; ownerId: string; streamUrl: string };

type WatchPartyStoreState = {
  active: boolean;
  roomId: string | null;
  partyId: string | null;
  streamUrl: string | null;
  ownerId: string | null;
  controllerId: string | null;
  mode: PlayerMode;
  announcedByRoom: Record<string, AnnouncedParty>;

  paused: boolean;
  positionSec: number;
  durationSec: number;
  playbackRate: number;
  audioTrackId: AudioTrackId;
  subTrackId: SubTrackId;
  subDelaySec: number;
  tracks: TrackInfo[];
  buffering: boolean;
  members: WatchPartyMember[];
  error: string | null;

  start: (roomId: string, streamUrl: string) => Promise<void>;
  join: (roomId: string) => Promise<void>;
  leave: () => void;
  end: () => void;
  setStreamUrl: (url: string) => Promise<void>;
  togglePlay: () => void;
  seek: (sec: number) => void;
  setRate: (rate: number) => void;
  setAudioTrack: (id: AudioTrackId) => void;
  setSubTrack: (id: SubTrackId) => void;
  setSubDelay: (sec: number) => void;
  addSubtitle: (file: File) => Promise<void>;
  handControlTo: (id: string) => void;

  _setSession: (v: {
    roomId: string;
    partyId: string;
    streamUrl: string;
    ownerId: string;
    controllerId: string;
  }) => void;
  _setMode: (mode: PlayerMode) => void;
  _setController: (id: string | null) => void;
  _setStreamUrl: (url: string) => void;
  _setPlayback: (v: Partial<Pick<WatchPartyStoreState,
    "paused" | "positionSec" | "durationSec" | "playbackRate" | "audioTrackId" | "subTrackId" | "subDelaySec">>) => void;
  _setTracks: (tracks: TrackInfo[]) => void;
  _setBuffering: (buffering: boolean) => void;
  _setMembers: (members: WatchPartyMember[]) => void;
  _setError: (error: string | null) => void;
  _setAnnounced: (roomId: string, party: AnnouncedParty) => void;
  _clearAnnounced: (roomId: string) => void;
  _clear: () => void;
};

function requireSelf(): Identity {
  const self = useIdentityStore.getState().self;
  if (!self) throw new Error("no local identity");
  return self;
}

export function selfIsController(): boolean {
  const s = useWatchPartyStore.getState();
  const self = useIdentityStore.getState().self;
  return !!self && s.controllerId === self.identityId;
}

const INITIAL = {
  active: false,
  roomId: null,
  partyId: null,
  streamUrl: null,
  ownerId: null,
  controllerId: null,
  mode: "none" as PlayerMode,
  paused: true,
  positionSec: 0,
  durationSec: 0,
  playbackRate: 1,
  audioTrackId: "auto" as AudioTrackId,
  subTrackId: "no" as SubTrackId,
  subDelaySec: 0,
  tracks: [] as TrackInfo[],
  buffering: false,
  members: [] as WatchPartyMember[],
  error: null as string | null,
};

export const useWatchPartyStore = create<WatchPartyStoreState>((set) => ({
  ...INITIAL,
  announcedByRoom: {},

  start: async (roomId, streamUrl) => {
    try {
      await watchPartyService.startParty(requireSelf(), roomId, streamUrl);
    } catch (err) {
      console.error("Failed to start watch party:", err);
      toast.error("Couldn't start watch party", "Please try again.");
    }
  },
  join: async (roomId) => {
    try {
      await watchPartyService.joinParty(requireSelf(), roomId);
    } catch (err) {
      console.error("Failed to join watch party:", err);
      toast.error("Couldn't join watch party", "Please try again.");
    }
  },
  leave: () => watchPartyService.leaveParty(),
  end: () => watchPartyService.endParty(),
  setStreamUrl: async (url) => {
    try {
      await watchPartyService.setStreamUrl(url);
    } catch (err) {
      console.error("Failed to set stream:", err);
      toast.error("Couldn't load stream", "Check the URL and try again.");
    }
  },
  togglePlay: () => watchPartyService.togglePlay(),
  seek: (sec) => watchPartyService.seek(sec),
  setRate: (rate) => watchPartyService.setRate(rate),
  setAudioTrack: (id) => watchPartyService.setAudioTrack(id),
  setSubTrack: (id) => watchPartyService.setSubTrack(id),
  setSubDelay: (sec) => watchPartyService.setSubDelay(sec),
  addSubtitle: (file) => watchPartyService.addSubtitle(file),
  handControlTo: (id) => watchPartyService.handControlTo(id),

  _setSession: (v) =>
    set({
      active: true,
      roomId: v.roomId,
      partyId: v.partyId,
      streamUrl: v.streamUrl,
      ownerId: v.ownerId,
      controllerId: v.controllerId,
      error: null,
    }),
  _setMode: (mode) => set({ mode }),
  _setController: (id) => set({ controllerId: id }),
  _setStreamUrl: (url) => set({ streamUrl: url }),
  _setPlayback: (v) => set(v),
  _setTracks: (tracks) => set({ tracks }),
  _setBuffering: (buffering) => set({ buffering }),
  _setMembers: (members) => set({ members }),
  _setError: (error) => set({ error }),
  _setAnnounced: (roomId, party) =>
    set((s) => ({ announcedByRoom: { ...s.announcedByRoom, [roomId]: party } })),
  _clearAnnounced: (roomId) =>
    set((s) => {
      const next = { ...s.announcedByRoom };
      delete next[roomId];
      return { announcedByRoom: next };
    }),
  _clear: () => set({ ...INITIAL }),
}));
