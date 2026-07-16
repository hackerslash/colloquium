import { ICE_SERVERS } from "../peer/iceServers";

export type PeerConnectionCallbacks = {
  /** Send an SDP offer/answer to the remote via the signaling transport. */
  onDescription: (description: RTCSessionDescriptionInit) => void;
  /** Send a local ICE candidate to the remote. */
  onCandidate: (candidate: RTCIceCandidateInit) => void;
  /** A remote media stream became available (or its tracks changed). */
  onRemoteStream: (stream: MediaStream) => void;
  /** Connection state transitions, for UI + higher-level recovery logic. */
  onConnectionStateChange: (state: RTCPeerConnectionState) => void;
};

/**
 * One raw RTCPeerConnection per remote peer, implementing the W3C "perfect
 * negotiation" pattern so track add/remove can renegotiate at any time from
 * either side without glare. Polite/impolite is decided deterministically by
 * the caller (lexicographic identityId compare) so both ends agree with no
 * coordination. Signaling (SDP/ICE) is transported by the caller via the
 * callbacks — this class is transport-agnostic.
 *
 * ICE restart and adaptive bitrate are layered on in Phase 5.
 */
export class PeerConnectionWrapper {
  readonly pc: RTCPeerConnection;
  private makingOffer = false;
  private ignoreOffer = false;
  private isSettingRemoteAnswerPending = false;
  private readonly remoteStream = new MediaStream();

  constructor(
    private readonly isPolite: boolean,
    private readonly callbacks: PeerConnectionCallbacks,
  ) {
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    this.pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await this.pc.setLocalDescription();
        if (this.pc.localDescription) {
          this.callbacks.onDescription(this.pc.localDescription.toJSON());
        }
      } catch (err) {
        console.error("negotiation failed", err);
      } finally {
        this.makingOffer = false;
      }
    };

    this.pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.callbacks.onCandidate(candidate.toJSON());
    };

    this.pc.ontrack = ({ track }) => {
      this.remoteStream.addTrack(track);
      this.callbacks.onRemoteStream(this.remoteStream);
      track.onended = () => this.remoteStream.removeTrack(track);
    };

    this.pc.onconnectionstatechange = () => {
      this.callbacks.onConnectionStateChange(this.pc.connectionState);
    };
  }

  addTrack(track: MediaStreamTrack, stream: MediaStream) {
    this.pc.addTrack(track, stream);
  }

  /** Replace/remove a sender's track without a full renegotiation storm where
   * possible (used when toggling camera on/off). */
  async replaceVideoTrack(track: MediaStreamTrack | null) {
    const sender = this.pc.getSenders().find((s) => s.track?.kind === "video");
    if (sender) await sender.replaceTrack(track);
  }

  async handleDescription(description: RTCSessionDescriptionInit) {
    // Perfect negotiation collision handling (per the W3C spec example).
    const readyForOffer =
      !this.makingOffer &&
      (this.pc.signalingState === "stable" || this.isSettingRemoteAnswerPending);
    const offerCollision = description.type === "offer" && !readyForOffer;

    this.ignoreOffer = !this.isPolite && offerCollision;
    if (this.ignoreOffer) return;

    this.isSettingRemoteAnswerPending = description.type === "answer";
    await this.pc.setRemoteDescription(description);
    this.isSettingRemoteAnswerPending = false;

    if (description.type === "offer") {
      await this.pc.setLocalDescription();
      if (this.pc.localDescription) {
        this.callbacks.onDescription(this.pc.localDescription.toJSON());
      }
    }
  }

  async handleCandidate(candidate: RTCIceCandidateInit) {
    try {
      await this.pc.addIceCandidate(candidate);
    } catch (err) {
      // A candidate arriving for an offer we deliberately ignored is expected.
      if (!this.ignoreOffer) throw err;
    }
  }

  close() {
    this.pc.getSenders().forEach((s) => s.track?.stop());
    this.pc.onnegotiationneeded = null;
    this.pc.onicecandidate = null;
    this.pc.ontrack = null;
    this.pc.onconnectionstatechange = null;
    this.pc.close();
  }
}
