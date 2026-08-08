import { ICE_SERVERS } from "./iceServers";

// Provider-agnostic connectivity self-test: gathers ICE against ICE_SERVERS and
// reports which candidate types came back — host (WebRTC works), srflx (STUN
// reached through NAT), relay (a TURN allocation succeeded). A missing relay is
// the otherwise-silent failure that leaves strict-NAT peers unable to connect.

export type IceCheckResult = {
  host: boolean;
  srflx: boolean;
  relay: boolean;
  candidateCount: number;
  /** Whether any turn:/turns: server is configured at all. If false, `relay`
   * being false is expected, not a failure. */
  turnConfigured: boolean;
  error?: string;
};

/** Pull the `typ <foo>` token out of a raw candidate string. Used as a fallback
 * when RTCIceCandidate.type isn't populated (older WebKit). Exported for test. */
export function parseCandidateType(candidate: string): string | null {
  const m = /\btyp (\w+)/.exec(candidate);
  return m ? m[1] : null;
}

function hasTurn(servers: RTCIceServer[]): boolean {
  return servers.some((s) => {
    const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
    return urls.some((u) => u.startsWith("turn:") || u.startsWith("turns:"));
  });
}

export async function checkIceConnectivity(timeoutMs = 8000): Promise<IceCheckResult> {
  const result: IceCheckResult = {
    host: false,
    srflx: false,
    relay: false,
    candidateCount: 0,
    turnConfigured: hasTurn(ICE_SERVERS),
  };

  let pc: RTCPeerConnection | null = null;
  try {
    pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    // A data channel is enough to make setLocalDescription kick off full ICE
    // gathering (including the TURN allocation) without any media permissions.
    pc.createDataChannel("probe");

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      const finish = () => {
        clearTimeout(timer);
        resolve();
      };
      pc!.onicecandidate = (e) => {
        if (!e.candidate) return finish(); // null candidate = gathering complete
        result.candidateCount++;
        const type = e.candidate.type ?? parseCandidateType(e.candidate.candidate);
        if (type === "host") result.host = true;
        else if (type === "srflx") result.srflx = true;
        else if (type === "relay") result.relay = true;
      };
      void pc!
        .createOffer()
        .then((offer) => pc!.setLocalDescription(offer))
        .catch((err) => {
          result.error = err instanceof Error ? err.message : String(err);
          finish();
        });
    });
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  } finally {
    pc?.close();
  }

  return result;
}
