import { create } from "zustand";
import type { Identity } from "../types/domain";
import type { ConnectionQuality } from "../services/call/PeerConnectionWrapper";
import * as callService from "../services/call/callService";
import { useIdentityStore } from "./useIdentityStore";
import { SCREEN_SHARE_OPTIONS, type ScreenShareQualityOption } from "../services/call/screenShareConfig";
import { toast } from "./useToastStore";

/** getUserMedia rejections don't carry a message worth showing a user
 * (e.g. "Permission denied"); a single friendly line covers the common
 * denied/no-device cases without misdiagnosing which one it was. */
const MEDIA_ERROR_HINT = "Check your microphone permissions and try again.";

export type CallStatus =
  | "idle"
  | "dialing" // invite not yet delivered (peer unreachable so far)
  | "outgoing" // invite sent, no ringing ack yet
  | "ringing" // callee confirmed the ring UI is showing
  | "incoming"
  | "connecting"
  | "active";

type ActiveCall = {
  roomId: string;
  remoteId: string;
  status: CallStatus;
  withVideo: boolean;
  inviteId?: string;
};

type CallState = {
  activeCall: ActiveCall | null;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  /** The remote's screen share (own msid), separate from mic+camera — a single
   * <video> only plays a stream's first video track, so screen must not share
   * a stream with the camera. */
  remoteScreenStream: MediaStream | null;
  mediaVersion: number;
  micOn: boolean;
  camOn: boolean;
  screenOn: boolean;
  /** Remote's announced camera/screen state; null until the first
   * call_media_state arrives (then falls back to track-mute detection). */
  remoteCamOn: boolean | null;
  remoteScreenOn: boolean | null;
  screenError: string | null;
  connectionState: RTCPeerConnectionState;
  quality: ConnectionQuality;
  speakingIds: Set<string>;
  screenConfig: ScreenShareQualityOption;
  /** Max mode's live link-tested bitrate cap (bps); null unless Max is active. */
  screenLinkBps: number | null;

  // User actions
  startCall: (roomId: string, remoteId: string, withVideo: boolean) => Promise<void>;
  acceptCall: () => Promise<void>;
  declineCall: () => void;
  hangUp: () => void;
  toggleMic: () => void;
  toggleCam: () => void;
  toggleScreenShare: () => Promise<void>;
  setScreenConfig: (config: ScreenShareQualityOption) => void;

  // Internal setters, driven by callService (prefixed _ by convention).
  _setActiveCall: (call: ActiveCall) => void;
  _setStatus: (status: CallStatus) => void;
  _setLocalStream: (stream: MediaStream | null) => void;
  _setRemoteStream: (stream: MediaStream | null) => void;
  _setRemoteScreenStream: (stream: MediaStream | null) => void;
  _setMediaFlags: (micOn: boolean, camOn: boolean) => void;
  _setRemoteMediaState: (camOn: boolean, screenOn: boolean) => void;
  _setScreenOn: (on: boolean) => void;
  _setScreenError: (error: string | null) => void;
  _setConnectionState: (state: RTCPeerConnectionState) => void;
  _setQuality: (quality: ConnectionQuality) => void;
  _setSpeaking: (ids: Set<string>) => void;
  _setScreenLinkBps: (bps: number | null) => void;
  _clear: () => void;
};

function requireSelf(): Identity {
  const self = useIdentityStore.getState().self;
  if (!self) throw new Error("no local identity");
  return self;
}

export const useCallStore = create<CallState>((set) => ({
  activeCall: null,
  localStream: null,
  remoteStream: null,
  remoteScreenStream: null,
  mediaVersion: 0,
  micOn: true,
  camOn: false,
  screenOn: false,
  remoteCamOn: null,
  remoteScreenOn: null,
  screenError: null,
  connectionState: "new",
  quality: "unknown",
  speakingIds: new Set<string>(),
  screenConfig: SCREEN_SHARE_OPTIONS[0],
  screenLinkBps: null,

  startCall: async (roomId, remoteId, withVideo) => {
    try {
      await callService.startCall(requireSelf(), roomId, remoteId, withVideo);
    } catch (err) {
      console.error("Failed to start call:", err);
      toast.error("Couldn't start call", MEDIA_ERROR_HINT);
    }
  },
  acceptCall: async () => {
    try {
      await callService.acceptCall(requireSelf());
    } catch (err) {
      console.error("Failed to accept call:", err);
      toast.error("Couldn't join call", MEDIA_ERROR_HINT);
    }
  },
  declineCall: () => callService.declineCall(requireSelf()),
  hangUp: () => callService.hangUp(),
  toggleMic: () => callService.toggleMic(),
  toggleCam: async () => {
    try {
      await callService.toggleCam();
    } catch (err) {
      console.error("Failed to toggle camera:", err);
      toast.error("Couldn't access the camera", MEDIA_ERROR_HINT);
    }
  },
  toggleScreenShare: async () => {
    try {
      if (useCallStore.getState().screenOn) await callService.stopScreenShare();
      else await callService.startScreenShare(useCallStore.getState().screenConfig);
    } catch (err) {
      // Post-capture awaits (replaceTrack on a closed pc) can reject; the
      // component fires this with `void`, so swallow it here rather than let it
      // surface as an unhandled rejection.
      console.error("Failed to toggle screen share:", err);
      toast.error("Screen share failed", "Couldn't change the screen share.");
    }
  },
  setScreenConfig: (config) => {
    set({ screenConfig: config });
    if (useCallStore.getState().screenOn) {
      void callService.updateScreenShareQuality(config);
    }
  },

  _setActiveCall: (call) => set({ activeCall: call }),
  _setStatus: (status) =>
    set((s) => ({ activeCall: s.activeCall ? { ...s.activeCall, status } : s.activeCall })),
  _setLocalStream: (stream) => set((s) => ({ localStream: stream, mediaVersion: s.mediaVersion + 1 })),
  _setRemoteStream: (stream) => set((s) => ({ remoteStream: stream, mediaVersion: s.mediaVersion + 1 })),
  _setRemoteScreenStream: (stream) =>
    set((s) => ({ remoteScreenStream: stream, mediaVersion: s.mediaVersion + 1 })),
  _setMediaFlags: (micOn, camOn) => set({ micOn, camOn }),
  _setRemoteMediaState: (camOn, screenOn) =>
    set((s) => ({ remoteCamOn: camOn, remoteScreenOn: screenOn, mediaVersion: s.mediaVersion + 1 })),
  _setScreenOn: (on) => set({ screenOn: on }),
  _setScreenError: (error) => set({ screenError: error }),
  _setConnectionState: (connectionState) => set({ connectionState }),
  _setQuality: (quality) => set({ quality }),
  _setSpeaking: (ids) => set({ speakingIds: ids }),
  _setScreenLinkBps: (bps) => set({ screenLinkBps: bps }),
  _clear: () =>
    set({
      activeCall: null,
      localStream: null,
      remoteStream: null,
      remoteScreenStream: null,
      micOn: true,
      camOn: false,
      screenOn: false,
      remoteCamOn: null,
      remoteScreenOn: null,
      screenError: null,
      connectionState: "new",
      quality: "unknown",
      speakingIds: new Set<string>(),
      screenLinkBps: null,
    }),
}));
