import { ICE_SERVERS } from "../peer/iceServers";

export type ConnectionQuality = "good" | "fair" | "poor" | "unknown";

export type VideoKind = "camera" | "screen";

export type PeerConnectionCallbacks = {
  /** Send an SDP offer/answer to the remote via the signaling transport. */
  onDescription: (description: RTCSessionDescriptionInit) => void;
  /** Send a local ICE candidate to the remote. */
  onCandidate: (candidate: RTCIceCandidateInit) => void;
  /** A remote media stream became available (or its tracks changed). Used by
   * the 1:1 path, which aggregates everything into one stream. */
  onRemoteStream?: (stream: MediaStream) => void;
  /** Per-track delivery with the remote's own stream grouping (msid) — used
   * by the room mesh to tell camera and screen streams apart. Re-fired on
   * mute/unmute/ended so the UI can react to replaceTrack(null) far-side. */
  onTrack?: (track: MediaStreamTrack, streams: readonly MediaStream[]) => void;
  /** Connection state transitions, for UI + higher-level recovery logic. */
  onConnectionStateChange: (state: RTCPeerConnectionState) => void;
  /** Measured link quality, updated from getStats() every couple seconds. */
  onQuality?: (quality: ConnectionQuality) => void;
  /** The bitrate cap Max mode currently applies to the screen sender, updated
   * as the link measurement moves. Only fires while Max mode is active. */
  onScreenBitrate?: (bps: number) => void;
};

type Tier = {
  maxBitrate: number;
  scaleResolutionDownBy: number;
  maxFramerate: number;
};

/** What drives a video sender's encoder: a fixed tier, "max" (link-probed
 * bitrate at native resolution), or undefined (adaptive tier ladder). */
export type TierSpec = Tier | "max" | undefined;

// Camera degrades resolution+framerate together as bitrate drops; index 0 is
// full quality (1080p30 @ 5 Mbps) and services clamp the ceiling per
// participant count. Screen keeps resolution (text legibility) and sheds fps.
const CAMERA_TIERS: Tier[] = [
  { maxBitrate: 5_000_000, scaleResolutionDownBy: 1, maxFramerate: 30 },
  { maxBitrate: 2_500_000, scaleResolutionDownBy: 1, maxFramerate: 30 },
  { maxBitrate: 1_200_000, scaleResolutionDownBy: 1.5, maxFramerate: 30 },
  { maxBitrate: 600_000, scaleResolutionDownBy: 2, maxFramerate: 24 },
  { maxBitrate: 300_000, scaleResolutionDownBy: 3, maxFramerate: 15 },
];
const SCREEN_TIERS: Tier[] = [
  { maxBitrate: 8_000_000, scaleResolutionDownBy: 1, maxFramerate: 30 },
  { maxBitrate: 2_500_000, scaleResolutionDownBy: 1, maxFramerate: 15 },
  { maxBitrate: 1_200_000, scaleResolutionDownBy: 1, maxFramerate: 8 },
  { maxBitrate: 600_000, scaleResolutionDownBy: 1.5, maxFramerate: 5 },
];
const TIERS: Record<VideoKind, Tier[]> = { camera: CAMERA_TIERS, screen: SCREEN_TIERS };

// --- Max mode: remote-desktop-style clarity. Native resolution + 60 fps are
// pinned; the bitrate cap follows the link's real capacity, measured per peer
// pair from the transport's bandwidth estimate (availableOutgoingBitrate).
// Where the stat isn't exposed (some WebKit builds) a probe walk stands in:
// grow on clean samples, halve on loss.
const MAX_MODE_START = 8_000_000;
const MAX_MODE_MIN = 2_500_000;
const MAX_MODE_MAX = 40_000_000;
/** Ceiling for the blind probe walk — without BWE we only learn about
 * overshoot from loss, so don't walk into absurd territory. */
const MAX_MODE_PROBE_MAX = 16_000_000;
/** Use this fraction of the estimate so the cap sits under capacity and the
 * estimate keeps room to move. */
const MAX_MODE_HEADROOM = 0.85;
/** Ignore cap moves smaller than this so setParameters isn't spammed. */
const MAX_MODE_HYSTERESIS = 0.15;

const CODEC_PREFERENCE = ["video/VP9", "video/AV1", "video/H264", "video/VP8"];

// Opus fmtp upgrades applied to every SDP that passes through this wrapper.
// WebRTC's Opus default is ~32 kbps forced-mono — fine for a phone call,
// terrible for shared system audio (music/video). stereo + a higher bitrate
// ceiling fix that; in-band FEC adds packet-loss resilience for voice at
// negligible cost. fmtp lines describe what the *receiver* wants, so we tune
// the local description we send out (asks the remote encoder for quality) AND
// the remote description we apply (activates it in our own encoder even if
// the peer runs an older build — an Opus decoder handles stereo/high-bitrate
// unconditionally).
const OPUS_PARAMS: Record<string, string> = {
  stereo: "1",
  "sprop-stereo": "1",
  maxaveragebitrate: "128000",
  useinbandfec: "1",
};

export function tuneOpusSdp(sdp: string): string {
  const lines = sdp.split("\r\n");
  const opusPts = new Set<string>();
  for (const line of lines) {
    const m = /^a=rtpmap:(\d+) opus\/48000/i.exec(line);
    if (m) opusPts.add(m[1]);
  }
  if (opusPts.size === 0) return sdp;

  const extra = Object.entries(OPUS_PARAMS)
    .map(([k, v]) => `${k}=${v}`)
    .join(";");
  const hadFmtp = new Set<string>();
  const upgraded = lines.map((line) => {
    const m = /^a=fmtp:(\d+) (.+)$/.exec(line);
    if (!m || !opusPts.has(m[1])) return line;
    hadFmtp.add(m[1]);
    const kept = m[2]
      .split(";")
      .map((p) => p.trim())
      .filter((p) => p && !(p.split("=")[0] in OPUS_PARAMS));
    return `a=fmtp:${m[1]} ${[...kept, extra].join(";")}`;
  });

  // An Opus rtpmap with no fmtp line at all gets one inserted right after it.
  const out: string[] = [];
  for (const line of upgraded) {
    out.push(line);
    const m = /^a=rtpmap:(\d+) opus\/48000/i.exec(line);
    if (m && !hadFmtp.has(m[1])) out.push(`a=fmtp:${m[1]} ${extra}`);
  }
  return out.join("\r\n");
}

const STATS_INTERVAL_MS = 2_000;
const ICE_DISCONNECT_GRACE_MS = 3_000;
const MAX_ICE_RESTARTS = 5;

type SenderAdaptation = {
  kind: VideoKind;
  tier: number;
  /** Best tier this sender may rise to (0 = full quality). Services clamp
   * this by participant count so a big mesh doesn't saturate uplink. */
  ceiling: number;
  goodStreak: number;
  badStreak: number;
  customTier?: Tier;
  /** Link-probed Max mode; overrides both customTier and the adaptive ladder. */
  maxMode?: boolean;
  /** The cap Max mode last applied, i.e. the converged link measurement. */
  maxModeBitrate?: number;
};

/**
 * One raw RTCPeerConnection per remote peer with W3C perfect negotiation,
 * ICE restart on disconnect/fail (grace timer + exponential backoff), and
 * per-video-sender adaptive quality: each sender walks a tier ladder
 * (bitrate + scaleResolutionDownBy + maxFramerate) driven by getStats loss/RTT.
 * Polite/impolite is decided by the caller (lexicographic identityId compare).
 *
 * This class never stops tracks — services own track lifecycle, because in a
 * mesh the same local tracks are attached to many wrappers.
 */
export class PeerConnectionWrapper {
  readonly pc: RTCPeerConnection;
  private makingOffer = false;
  private ignoreOffer = false;
  private isSettingRemoteAnswerPending = false;
  private readonly remoteStream = new MediaStream();

  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private iceRestartAttempts = 0;
  private videoSenders = new Map<RTCRtpSender, SenderAdaptation>();
  private lastPacketsLost = 0;
  private lastPacketsSent = 0;
  private closed = false;

  constructor(
    private readonly isPolite: boolean,
    private readonly callbacks: PeerConnectionCallbacks,
  ) {
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    this.pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await this.pc.setLocalDescription();
        this.sendLocalDescription();
      } catch (err) {
        console.error("negotiation failed", err);
      } finally {
        this.makingOffer = false;
      }
    };

    this.pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.callbacks.onCandidate(candidate.toJSON());
    };

    this.pc.ontrack = ({ track, streams }) => {
      if (this.callbacks.onTrack) {
        const refire = () => this.callbacks.onTrack?.(track, streams);
        track.onmute = refire;
        track.onunmute = refire;
        track.onended = refire;
        refire();
        return;
      }
      this.remoteStream.addTrack(track);
      this.callbacks.onRemoteStream?.(this.remoteStream);
      // Refire on mute/unmute so the UI can drop a frozen last frame when the
      // remote's RTP stops (crash, network death) instead of displaying it.
      const refire = () => this.callbacks.onRemoteStream?.(this.remoteStream);
      track.onmute = refire;
      track.onunmute = refire;
      track.onended = () => {
        this.remoteStream.removeTrack(track);
        refire();
      };
    };

    this.pc.onconnectionstatechange = () => {
      this.callbacks.onConnectionStateChange(this.pc.connectionState);
      if (this.pc.connectionState === "connected") this.iceRestartAttempts = 0;
    };

    this.pc.oniceconnectionstatechange = () => this.handleIceStateChange();

    this.statsTimer = setInterval(() => void this.sampleStats(), STATS_INTERVAL_MS);
  }

  addTrack(track: MediaStreamTrack, stream: MediaStream) {
    this.pc.addTrack(track, stream);
  }

  /** Adds a video track with full quality plumbing: initial encodings from
   * the tier ladder, degradationPreference, contentHint, codec preferences,
   * and registration with the per-sender adaptation loop. */
  addVideoTrack(
    track: MediaStreamTrack,
    stream: MediaStream,
    kind: VideoKind,
    ceiling = 0,
    tierSpec?: TierSpec,
  ): RTCRtpSender {
    const tiers = TIERS[kind];
    const startTier = Math.min(Math.max(ceiling, 0), tiers.length - 1);
    try {
      // "text" biases the codec's screen-content tools toward legibility
      // (crisp glyph edges over smooth gradients); assigning an unsupported
      // hint is a silent no-op, so "detail" first as the fallback.
      track.contentHint = kind === "screen" ? "detail" : "motion";
      if (kind === "screen") track.contentHint = "text";
    } catch {
      // contentHint is advisory; absence is fine
    }

    const isMax = tierSpec === "max";
    const customTier = isMax || tierSpec === undefined ? undefined : tierSpec;
    const initialTier: Tier = isMax
      ? { maxBitrate: MAX_MODE_START, scaleResolutionDownBy: 1, maxFramerate: 60 }
      : (customTier ?? tiers[startTier]);
    const transceiver = this.pc.addTransceiver(track, {
      direction: "sendrecv",
      streams: [stream],
      sendEncodings: [
        {
          maxBitrate: initialTier.maxBitrate,
          scaleResolutionDownBy: initialTier.scaleResolutionDownBy,
          maxFramerate: initialTier.maxFramerate,
        },
      ],
    });

    try {
      const caps = RTCRtpSender.getCapabilities("video");
      if (caps && typeof transceiver.setCodecPreferences === "function") {
        const rank = (mime: string) => {
          const i = CODEC_PREFERENCE.indexOf(mime);
          return i === -1 ? CODEC_PREFERENCE.length : i;
        };
        const sorted = [...caps.codecs].sort((a, b) => rank(a.mimeType) - rank(b.mimeType));
        transceiver.setCodecPreferences(sorted);
      }
    } catch {
      // Unsupported (e.g. older WebKit) — default codec negotiation is fine.
    }

    const sender = transceiver.sender;
    const params = sender.getParameters();
    params.degradationPreference = kind === "screen" ? "maintain-resolution" : "balanced";
    sender.setParameters(params).catch(() => {});

    this.videoSenders.set(sender, {
      kind,
      tier: startTier,
      ceiling: startTier,
      goodStreak: 0,
      badStreak: 0,
      customTier,
      maxMode: isMax,
      maxModeBitrate: isMax ? MAX_MODE_START : undefined,
    });
    if (isMax) this.callbacks.onScreenBitrate?.(MAX_MODE_START);
    return sender;
  }

  hasVideoSender(kind: VideoKind): boolean {
    for (const state of this.videoSenders.values()) {
      if (state.kind === kind) return true;
    }
    return false;
  }

  /** Swaps (or clears with null) the outgoing video for a kind without
   * renegotiating. With no `kind`, targets the first video sender (1:1 path
   * that predates multi-sender). */
  async replaceVideoTrack(track: MediaStreamTrack | null, kind?: VideoKind) {
    if (kind) {
      for (const [sender, state] of this.videoSenders) {
        if (state.kind === kind) {
          await sender.replaceTrack(track);
          return;
        }
      }
      return;
    }
    const sender = this.pc.getSenders().find((s) => s.track?.kind === "video");
    if (sender) await sender.replaceTrack(track);
  }

  /** Detaches a specific outgoing track (audio or video) without stopping it. */
  async detachTrack(track: MediaStreamTrack) {
    const sender = this.pc.getSenders().find((s) => s.track === track);
    if (sender) await sender.replaceTrack(null);
  }

  /** Clamps how high a kind's senders may climb (0 = full quality). Applies
   * immediately if the sender currently sits above the new ceiling. */
  setVideoCeiling(kind: VideoKind, ceiling: number) {
    for (const [sender, state] of this.videoSenders) {
      if (state.kind !== kind) continue;
      const clamped = Math.min(Math.max(ceiling, 0), TIERS[kind].length - 1);
      state.ceiling = clamped;
      if (state.tier < clamped) this.applyTier(sender, state, clamped);
    }
  }

  /** Applies a fixed tier or link-probed Max mode overriding adaptive
   * quality, or (undefined) reverts to the adaptive ladder. */
  applyVideoTier(kind: VideoKind, tierSpec?: TierSpec) {
    for (const [sender, state] of this.videoSenders) {
      if (state.kind !== kind) continue;
      if (tierSpec === "max") {
        state.customTier = undefined;
        if (!state.maxMode) {
          state.maxMode = true;
          state.maxModeBitrate = MAX_MODE_START;
          this.setEncoding(sender, MAX_MODE_START, 1, 60);
          this.callbacks.onScreenBitrate?.(MAX_MODE_START);
        }
        continue;
      }
      state.maxMode = false;
      state.maxModeBitrate = undefined;
      state.customTier = tierSpec;
      if (tierSpec) {
        this.setEncoding(
          sender,
          tierSpec.maxBitrate,
          tierSpec.scaleResolutionDownBy,
          tierSpec.maxFramerate,
        );
      } else {
        this.applyTier(sender, state, state.tier);
      }
    }
  }

  async handleDescription(description: RTCSessionDescriptionInit) {
    const readyForOffer =
      !this.makingOffer &&
      (this.pc.signalingState === "stable" || this.isSettingRemoteAnswerPending);
    const offerCollision = description.type === "offer" && !readyForOffer;

    this.ignoreOffer = !this.isPolite && offerCollision;
    if (this.ignoreOffer) return;

    this.isSettingRemoteAnswerPending = description.type === "answer";
    const tuned = description.sdp
      ? { ...description, sdp: tuneOpusSdp(description.sdp) }
      : description;
    await this.pc.setRemoteDescription(tuned);
    this.isSettingRemoteAnswerPending = false;

    if (description.type === "offer") {
      await this.pc.setLocalDescription();
      this.sendLocalDescription();
    }
  }

  /** Ships the current local description through signaling with the Opus
   * receive preferences (stereo, bitrate, FEC) stamped in. */
  private sendLocalDescription() {
    const description = this.pc.localDescription;
    if (!description) return;
    const json = description.toJSON();
    if (json.sdp) json.sdp = tuneOpusSdp(json.sdp);
    this.callbacks.onDescription(json);
  }

  async handleCandidate(candidate: RTCIceCandidateInit) {
    try {
      await this.pc.addIceCandidate(candidate);
    } catch (err) {
      if (!this.ignoreOffer) throw err;
    }
  }

  // --- ICE restart ---

  private handleIceStateChange() {
    const state = this.pc.iceConnectionState;
    if (state === "connected" || state === "completed") {
      if (this.disconnectTimer) {
        clearTimeout(this.disconnectTimer);
        this.disconnectTimer = null;
      }
      return;
    }
    if (state === "disconnected") {
      // Transient blips often self-heal; wait out a grace period first.
      if (!this.disconnectTimer) {
        this.disconnectTimer = setTimeout(() => {
          this.disconnectTimer = null;
          if (this.pc.iceConnectionState !== "connected") this.scheduleIceRestart();
        }, ICE_DISCONNECT_GRACE_MS);
      }
    } else if (state === "failed") {
      this.scheduleIceRestart();
    }
  }

  private scheduleIceRestart() {
    if (this.closed || this.iceRestartAttempts >= MAX_ICE_RESTARTS) return;
    // Only the impolite peer initiates the restart offer, so both sides don't
    // fire competing restarts; perfect negotiation would resolve glare anyway,
    // but this keeps the churn down.
    if (this.isPolite) return;

    const attempt = this.iceRestartAttempts++;
    const backoff = Math.min(1_000 * 2 ** attempt, 30_000);
    setTimeout(() => {
      if (this.closed || this.pc.iceConnectionState === "connected") return;
      try {
        this.pc.restartIce();
      } catch (err) {
        console.warn("ICE restart failed", err);
      }
    }, backoff);
  }

  // --- Adaptive quality ---

  private async sampleStats() {
    if (this.closed) return;
    const stats = await this.pc.getStats().catch(() => null);
    if (!stats) return;

    let rtt = 0;
    let fractionLost = 0;
    let sawRemoteInbound = false;
    let availableOutgoingBps = 0;

    stats.forEach((report) => {
      if (report.type === "remote-inbound-rtp") {
        sawRemoteInbound = true;
        if (typeof report.roundTripTime === "number") rtt = report.roundTripTime;
        if (typeof report.fractionLost === "number") fractionLost = report.fractionLost;
      } else if (
        report.type === "candidate-pair" &&
        typeof report.availableOutgoingBitrate === "number"
      ) {
        // Only the selected pair carries the estimate; max() covers the brief
        // window where more than one reports during a switch.
        availableOutgoingBps = Math.max(availableOutgoingBps, report.availableOutgoingBitrate);
      } else if (report.type === "outbound-rtp" && report.kind === "video") {
        // Fallback loss estimate from cumulative counters if no remote report.
        const lost = (report.packetsLost as number) ?? this.lastPacketsLost;
        const sent = (report.packetsSent as number) ?? this.lastPacketsSent;
        const dLost = lost - this.lastPacketsLost;
        const dSent = sent - this.lastPacketsSent;
        if (!sawRemoteInbound && dSent > 0) fractionLost = Math.max(0, dLost / dSent);
        this.lastPacketsLost = lost;
        this.lastPacketsSent = sent;
      }
    });

    this.reportQuality(rtt, fractionLost);
    this.adaptMaxMode(availableOutgoingBps, rtt, fractionLost);
    this.adaptQuality(rtt, fractionLost);
  }

  /** Max mode's control loop: follow the transport's bandwidth estimate with
   * some headroom; without the stat, walk the cap up on clean samples and
   * halve it on loss. Resolution and framerate stay pinned — only bits move. */
  private adaptMaxMode(availableBps: number, rtt: number, fractionLost: number) {
    for (const [sender, state] of this.videoSenders) {
      if (!state.maxMode) continue;
      if (!sender.track || sender.track.readyState !== "live") continue;

      const current = state.maxModeBitrate ?? MAX_MODE_START;
      let next = current;
      if (availableBps > 0) {
        next = Math.min(Math.max(availableBps * MAX_MODE_HEADROOM, MAX_MODE_MIN), MAX_MODE_MAX);
      } else if (fractionLost > 0.05 || rtt > 0.4) {
        next = Math.max(current / 2, MAX_MODE_MIN);
      } else if (fractionLost < 0.01 && rtt < 0.25) {
        next = Math.min(current * 1.25, MAX_MODE_PROBE_MAX);
      }

      if (Math.abs(next - current) / current < MAX_MODE_HYSTERESIS) continue;
      state.maxModeBitrate = next;
      this.setEncoding(sender, next, 1, 60);
      this.callbacks.onScreenBitrate?.(Math.round(next));
    }
  }

  private reportQuality(rtt: number, fractionLost: number) {
    let quality: ConnectionQuality = "good";
    if (fractionLost > 0.1 || rtt > 0.5) quality = "poor";
    else if (fractionLost > 0.03 || rtt > 0.3) quality = "fair";
    this.callbacks.onQuality?.(quality);
  }

  private adaptQuality(rtt: number, fractionLost: number) {
    const bad = fractionLost > 0.05 || rtt > 0.4;
    const good = fractionLost < 0.02 && rtt < 0.2;

    for (const [sender, state] of this.videoSenders) {
      if (!sender.track || sender.track.readyState !== "live") continue;

      if (bad) {
        state.badStreak++;
        state.goodStreak = 0;
      } else if (good) {
        state.goodStreak++;
        state.badStreak = 0;
      } else {
        state.goodStreak = 0;
        state.badStreak = 0;
      }

      const tiers = TIERS[state.kind];
      let nextTier = state.tier;
      if (state.badStreak >= 2 && state.tier < tiers.length - 1) {
        nextTier = state.tier + 1;
        state.badStreak = 0;
      } else if (state.goodStreak >= 10 && state.tier > state.ceiling) {
        nextTier = state.tier - 1;
        state.goodStreak = 0;
      }
      if (nextTier !== state.tier && !state.customTier && !state.maxMode) {
        this.applyTier(sender, state, nextTier);
      }
    }
  }

  private applyTier(sender: RTCRtpSender, state: SenderAdaptation, tierIndex: number) {
    state.tier = tierIndex;
    const tier = TIERS[state.kind][tierIndex];
    this.setEncoding(sender, tier.maxBitrate, tier.scaleResolutionDownBy, tier.maxFramerate);
  }

  private setEncoding(
    sender: RTCRtpSender,
    maxBitrate: number,
    scaleResolutionDownBy: number,
    maxFramerate: number,
  ) {
    // getParameters must be fresh right before setParameters (stale
    // transactionId is rejected).
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
    params.encodings[0].maxBitrate = Math.round(maxBitrate);
    params.encodings[0].scaleResolutionDownBy = scaleResolutionDownBy;
    params.encodings[0].maxFramerate = maxFramerate;
    sender.setParameters(params).catch(() => {});
  }

  close() {
    this.closed = true;
    if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
    if (this.statsTimer) clearInterval(this.statsTimer);
    // Deliberately does NOT stop sender tracks: they're shared local tracks
    // (attached to every wrapper in a mesh) owned by the call services.
    this.videoSenders.clear();
    this.pc.onnegotiationneeded = null;
    this.pc.onicecandidate = null;
    this.pc.ontrack = null;
    this.pc.onconnectionstatechange = null;
    this.pc.oniceconnectionstatechange = null;
    this.pc.close();
  }
}
