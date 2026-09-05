import { create } from "zustand";
import type { Identity } from "../types/domain";
import type {
  AudioTrackId,
  SubTrackId,
  TrackInfo,
} from "../services/watchparty/watchPartyPlayer";
import * as watchPartyService from "../services/watchparty/watchPartyService";
import { useIdentityStore } from "./useIdentityStore";
import { toast } from "./useToastStore";

export type WatchPartyMember = {
  id: string;
  ready: boolean;
  primed: boolean;
  bufferedSec: number;
  /** This peer's own priming target: a direct-play peer needs far less than a
   * remuxing one, so one shared threshold misreports both. */
  needSec: number;
};
export type AnnouncedParty = {
  partyId: string;
  ownerId: string;
  streamUrl: string;
  startedAt: number;
};

type PlaybackSlice = {
  paused: boolean;
  positionSec: number;
  durationSec: number;
  playbackRate: number;
  audioTrackId: AudioTrackId;
  subTrackId: SubTrackId;
  subDelaySec: number;
};

type WatchPartyStoreState = {
  active: boolean;
  roomId: string | null;
  partyId: string | null;
  streamUrl: string | null;
  /** What the source calls itself, when the backend can say — YouTube's player
   * knows the video's title, a file on disk does not. */
  videoTitle: string | null;
  ownerId: string | null;
  controllerId: string | null;
  announcedByRoom: Record<string, AnnouncedParty>;

  paused: boolean;
  positionSec: number;
  durationSec: number;
  playbackRate: number;
  audioTrackId: AudioTrackId;
  subTrackId: SubTrackId;
  subDelaySec: number;
  tracks: TrackInfo[];
  subLoading: boolean;
  /** 0..1 through the source while cues are being extracted, null when unknown.
   * A 4K source takes minutes, so the wait needs a number against it. */
  subProgress: number | null;
  buffering: boolean;
  /** Footage ready ahead of the local playhead, so the scrubber can draw what is
   * actually loaded rather than a decorative fill. */
  bufferedSec: number;
  members: WatchPartyMember[];
  /** Peers the controller is waiting on before play starts. Empty unless a play
   * has actually been asked for and gated. */
  waitingFor: string[];
  error: string | null;

  start: (roomId: string, streamUrl: string) => Promise<void>;
  join: (roomId: string) => Promise<void>;
  leave: () => void;
  end: () => void;
  setStreamUrl: (url: string) => Promise<void>;
  togglePlay: () => void;
  startAnyway: () => void;
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
    ownerId: string | null;
    controllerId: string | null;
  }) => void;
  _setController: (id: string | null) => void;
  _setStreamUrl: (url: string) => void;
  _setVideoTitle: (title: string | null) => void;
  _setPlayback: (v: Partial<PlaybackSlice>) => void;
  _setTracks: (tracks: TrackInfo[]) => void;
  _setSubLoading: (loading: boolean, progress?: number | null) => void;
  _setBuffering: (buffering: boolean) => void;
  _setPresence: (members: WatchPartyMember[], bufferedSec: number) => void;
  _setWaitingFor: (ids: string[]) => void;
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

const INITIAL: PlaybackSlice & {
  active: boolean;
  roomId: null;
  partyId: null;
  streamUrl: null;
  videoTitle: null;
  ownerId: null;
  controllerId: null;
  tracks: TrackInfo[];
  subLoading: boolean;
  subProgress: number | null;
  buffering: boolean;
  bufferedSec: number;
  members: WatchPartyMember[];
  waitingFor: string[];
  error: null;
} = {
  active: false,
  roomId: null,
  partyId: null,
  streamUrl: null,
  videoTitle: null,
  ownerId: null,
  controllerId: null,
  paused: true,
  positionSec: 0,
  durationSec: 0,
  playbackRate: 1,
  audioTrackId: "auto" as AudioTrackId,
  subTrackId: "no" as SubTrackId,
  subDelaySec: 0,
  tracks: [] as TrackInfo[],
  subLoading: false,
  subProgress: null,
  buffering: false,
  bufferedSec: 0,
  members: [],
  waitingFor: [],
  error: null,
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
  startAnyway: () => watchPartyService.startAnyway(),
  seek: (sec) => watchPartyService.seek(sec),
  setRate: (rate) => watchPartyService.setRate(rate),
  setAudioTrack: (id) => watchPartyService.setAudioTrack(id),
  setSubTrack: (id) => watchPartyService.setSubTrack(id),
  setSubDelay: (sec) => watchPartyService.setSubDelay(sec),
  addSubtitle: async (file) => {
    try {
      await watchPartyService.addSubtitle(file);
    } catch (err) {
      console.error("Failed to add subtitle:", err);
      toast.error("Couldn't add subtitles", "The file couldn't be read.");
    }
  },
  handControlTo: (id) => watchPartyService.handControlTo(id),

  _setSession: (v) =>
    set({
      active: true,
      roomId: v.roomId,
      partyId: v.partyId,
      streamUrl: v.streamUrl,
      videoTitle: null,
      ownerId: v.ownerId,
      controllerId: v.controllerId,
      error: null,
    }),
  _setController: (id) => set({ controllerId: id }),
  _setStreamUrl: (url) => set({ streamUrl: url, videoTitle: null }),
  _setVideoTitle: (videoTitle) => set({ videoTitle }),
  _setPlayback: (v) => set(v),
  _setTracks: (tracks) => set({ tracks }),
  _setSubLoading: (subLoading, subProgress = null) => set({ subLoading, subProgress }),
  _setBuffering: (buffering) => set({ buffering }),
  _setPresence: (members, bufferedSec) => set({ members, bufferedSec }),
  _setWaitingFor: (waitingFor) => set({ waitingFor }),
  _setError: (error) => set({ error }),
  _setAnnounced: (roomId, party) =>
    set((s) => {
      // The controller re-announces on every heartbeat, so the unchanged case is
      // the common one and must not allocate — every room header subscribes.
      const prev = s.announcedByRoom[roomId];
      if (
        prev &&
        prev.partyId === party.partyId &&
        prev.ownerId === party.ownerId &&
        prev.streamUrl === party.streamUrl
      ) {
        return {};
      }
      return { announcedByRoom: { ...s.announcedByRoom, [roomId]: party } };
    }),
  _clearAnnounced: (roomId) =>
    set((s) => {
      if (!s.announcedByRoom[roomId]) return {};
      const next = { ...s.announcedByRoom };
      delete next[roomId];
      return { announcedByRoom: next };
    }),
  _clear: () => set({ ...INITIAL }),
}));
