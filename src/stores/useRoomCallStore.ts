import { create } from "zustand";
import type { Identity } from "../types/domain";
import type { PresenterSlotWire } from "../types/wire";
import type { ConnectionQuality } from "../services/call/PeerConnectionWrapper";
import * as roomCallService from "../services/call/roomCallService";
import * as roomMembersRepo from "../services/db/roomMembersRepo";
import { useIdentityStore } from "./useIdentityStore";
import { SCREEN_SHARE_OPTIONS, type ScreenShareQualityOption } from "../services/call/screenShareConfig";
import { toast } from "./useToastStore";

type RoomCallState = {
  roomId: string | null;
  participants: string[];
  slots: PresenterSlotWire[];
  /** Main (mic + camera) stream per participant. */
  streamsByParticipant: Record<string, MediaStream>;
  /** Screen-share stream per participant (absent = not sharing). */
  screenStreamsByParticipant: Record<string, MediaStream>;
  connectionByParticipant: Record<string, RTCPeerConnectionState>;
  qualityByParticipant: Record<string, ConnectionQuality>;
  localStream: MediaStream | null;
  micOn: boolean;
  camOn: boolean;
  screenOn: boolean;
  presentError: string | null;
  /** Bumped whenever tracks mute/unmute/arrive so components re-derive
   * hasVideo from live MediaStream objects (same refs, changed contents). */
  mediaVersion: number;
  speakingIds: Set<string>;
  screenConfig: ScreenShareQualityOption;
  /** Max mode's live link-tested bitrate cap (bps) — the weakest peer link.
   * Null unless Max is active on our own share. */
  screenLinkBps: number | null;

  join: (roomId: string) => Promise<void>;
  leave: () => void;
  toggleMic: () => void;
  toggleCam: () => Promise<void>;
  toggleScreenShare: () => Promise<void>;
  setScreenConfig: (config: ScreenShareQualityOption) => void;

  _setSession: (roomId: string) => void;
  _setParticipants: (ids: string[]) => void;
  _removeParticipant: (id: string) => void;
  _setSlots: (slots: PresenterSlotWire[]) => void;
  _setParticipantStream: (id: string, stream: MediaStream) => void;
  _setParticipantScreenStream: (id: string, stream: MediaStream | null) => void;
  _setParticipantConnection: (id: string, state: RTCPeerConnectionState) => void;
  _setParticipantQuality: (id: string, quality: ConnectionQuality) => void;
  _setLocalStream: (stream: MediaStream | null) => void;
  _setMicOn: (on: boolean) => void;
  _setCamOn: (on: boolean) => void;
  _setScreenOn: (on: boolean) => void;
  _setPresentError: (error: string | null) => void;
  _bumpMediaVersion: () => void;
  _setSpeaking: (ids: Set<string>) => void;
  _setScreenLinkBps: (bps: number | null) => void;
  _clear: () => void;
};

function requireSelf(): Identity {
  const self = useIdentityStore.getState().self;
  if (!self) throw new Error("no local identity");
  return self;
}

export const useRoomCallStore = create<RoomCallState>((set) => ({
  roomId: null,
  participants: [],
  slots: [],
  streamsByParticipant: {},
  screenStreamsByParticipant: {},
  connectionByParticipant: {},
  qualityByParticipant: {},
  localStream: null,
  micOn: true,
  camOn: false,
  screenOn: false,
  presentError: null,
  mediaVersion: 0,
  speakingIds: new Set<string>(),
  screenConfig: SCREEN_SHARE_OPTIONS[0],
  screenLinkBps: null,

  join: async (roomId) => {
    try {
      const self = requireSelf();
      const memberIds = await roomMembersRepo.listMembers(roomId);
      await roomCallService.joinRoomCall(self, roomId, memberIds);
    } catch (err) {
      console.error("Failed to join room call:", err);
      toast.error("Couldn't join call", "Check your microphone permissions and try again.");
    }
  },
  leave: () => roomCallService.leaveRoomCall(),
  toggleMic: () => roomCallService.toggleMic(),
  toggleCam: () => roomCallService.toggleCam(),
  toggleScreenShare: async () => {
    if (useRoomCallStore.getState().screenOn) roomCallService.stopScreenShare();
    else await roomCallService.startScreenShare(useRoomCallStore.getState().screenConfig);
  },
  setScreenConfig: (config) => {
    set({ screenConfig: config });
    if (useRoomCallStore.getState().screenOn) {
      void roomCallService.updateScreenShareQuality(config);
    }
  },

  _setSession: (roomId) => set({ roomId, presentError: null }),
  _setParticipants: (ids) => set({ participants: ids }),
  _removeParticipant: (id) =>
    set((s) => {
      const streams = { ...s.streamsByParticipant };
      const screens = { ...s.screenStreamsByParticipant };
      const conns = { ...s.connectionByParticipant };
      const quals = { ...s.qualityByParticipant };
      delete streams[id];
      delete screens[id];
      delete conns[id];
      delete quals[id];
      return {
        participants: s.participants.filter((p) => p !== id),
        streamsByParticipant: streams,
        screenStreamsByParticipant: screens,
        connectionByParticipant: conns,
        qualityByParticipant: quals,
      };
    }),
  _setSlots: (slots) => set({ slots }),
  _setParticipantStream: (id, stream) =>
    set((s) => ({ streamsByParticipant: { ...s.streamsByParticipant, [id]: stream } })),
  _setParticipantScreenStream: (id, stream) =>
    set((s) => {
      const screens = { ...s.screenStreamsByParticipant };
      if (stream) screens[id] = stream;
      else delete screens[id];
      return { screenStreamsByParticipant: screens };
    }),
  _setParticipantConnection: (id, state) =>
    set((s) => ({ connectionByParticipant: { ...s.connectionByParticipant, [id]: state } })),
  _setParticipantQuality: (id, quality) =>
    set((s) => ({ qualityByParticipant: { ...s.qualityByParticipant, [id]: quality } })),
  _setLocalStream: (stream) => set({ localStream: stream }),
  _setMicOn: (on) => set({ micOn: on }),
  _setCamOn: (on) => set({ camOn: on }),
  _setScreenOn: (on) => set({ screenOn: on }),
  _setPresentError: (error) => set({ presentError: error }),
  _bumpMediaVersion: () => set((s) => ({ mediaVersion: s.mediaVersion + 1 })),
  _setSpeaking: (ids) => set({ speakingIds: ids }),
  _setScreenLinkBps: (bps) => set({ screenLinkBps: bps }),
  _clear: () =>
    set({
      roomId: null,
      participants: [],
      slots: [],
      streamsByParticipant: {},
      screenStreamsByParticipant: {},
      connectionByParticipant: {},
      qualityByParticipant: {},
      localStream: null,
      micOn: true,
      camOn: false,
      screenOn: false,
      presentError: null,
      mediaVersion: 0,
      speakingIds: new Set<string>(),
      screenLinkBps: null,
    }),
}));
