// STUN gets peers on friendly NATs connected; peers behind symmetric NAT or a
// strict firewall need a TURN relay, which is currently NOT configured.
//
// TODO(turn): add turn:/turns: entries with valid credentials (Metered, coturn,
// Twilio, …). The old Open Relay free tier that lived here was discontinued and
// is dead. Two providers is safer than one — a single free relay going dark is
// how connectivity broke silently before.
export const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
];
