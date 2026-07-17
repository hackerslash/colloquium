import { create } from "zustand";
import type { Identity } from "../types/domain";
import type { ConnectionQuality } from "../services/call/PeerConnectionWrapper";
import * as callService from "../services/call/callService";
import { useIdentityStore } from "./useIdentityStore";

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
  micOn: boolean;
  camOn: boolean;
  screenOn: boolean;
  screenError: string | null;
  connectionState: RTCPeerConnectionState;
  quality: ConnectionQuality;

  // User actions
  startCall: (roomId: string, remoteId: string, withVideo: boolean) => Promise<void>;
  acceptCall: () => Promise<void>;
  declineCall: () => void;
  hangUp: () => void;
  toggleMic: () => void;
  toggleCam: () => void;
  toggleScreenShare: () => Promise<void>;

  // Internal setters, driven by callService (prefixed _ by convention).
  _setActiveCall: (call: ActiveCall) => void;
  _setStatus: (status: CallStatus) => void;
  _setLocalStream: (stream: MediaStream | null) => void;
  _setRemoteStream: (stream: MediaStream | null) => void;
  _setMediaFlags: (micOn: boolean, camOn: boolean) => void;
  _setScreenOn: (on: boolean) => void;
  _setScreenError: (error: string | null) => void;
  _setConnectionState: (state: RTCPeerConnectionState) => void;
  _setQuality: (quality: ConnectionQuality) => void;
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
  micOn: true,
  camOn: false,
  screenOn: false,
  screenError: null,
  connectionState: "new",
  quality: "unknown",

  startCall: (roomId, remoteId, withVideo) =>
    callService.startCall(requireSelf(), roomId, remoteId, withVideo),
  acceptCall: () => callService.acceptCall(requireSelf()),
  declineCall: () => callService.declineCall(requireSelf()),
  hangUp: () => callService.hangUp(),
  toggleMic: () => callService.toggleMic(),
  toggleCam: () => callService.toggleCam(),
  toggleScreenShare: async () => {
    if (useCallStore.getState().screenOn) await callService.stopScreenShare();
    else await callService.startScreenShare();
  },

  _setActiveCall: (call) => set({ activeCall: call }),
  _setStatus: (status) =>
    set((s) => ({ activeCall: s.activeCall ? { ...s.activeCall, status } : s.activeCall })),
  _setLocalStream: (stream) => set({ localStream: stream }),
  _setRemoteStream: (stream) => set({ remoteStream: stream }),
  _setMediaFlags: (micOn, camOn) => set({ micOn, camOn }),
  _setScreenOn: (on) => set({ screenOn: on }),
  _setScreenError: (error) => set({ screenError: error }),
  _setConnectionState: (connectionState) => set({ connectionState }),
  _setQuality: (quality) => set({ quality }),
  _clear: () =>
    set({
      activeCall: null,
      localStream: null,
      remoteStream: null,
      micOn: true,
      camOn: false,
      screenOn: false,
      screenError: null,
      connectionState: "new",
      quality: "unknown",
    }),
}));
