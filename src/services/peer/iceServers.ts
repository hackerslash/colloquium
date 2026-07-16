// STUN alone (PeerJS's cloud broker default) leaves peers behind symmetric
// NAT/strict firewalls unable to connect at all. Open Relay Project's free
// TURN tier is a hosted third-party service — still no backend of our own to
// run — that closes that gap. Swap for a dedicated account if usage grows
// past their free tier.
export const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  {
    urls: "turn:openrelay.metered.ca:80",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
  {
    urls: "turn:openrelay.metered.ca:443",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
  {
    urls: "turn:openrelay.metered.ca:443?transport=tcp",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
];
