import { describe, expect, it } from "vitest";
import { tuneOpusSdp } from "./PeerConnectionWrapper";

const SDP_WITH_FMTP = [
  "v=0",
  "o=- 1 1 IN IP4 127.0.0.1",
  "s=-",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111 63",
  "a=rtpmap:111 opus/48000/2",
  "a=fmtp:111 minptime=10;useinbandfec=1",
  "a=rtpmap:63 red/48000/2",
  "m=video 9 UDP/TLS/RTP/SAVPF 96",
  "a=rtpmap:96 VP8/90000",
].join("\r\n");

describe("tuneOpusSdp", () => {
  it("upgrades an existing opus fmtp line, keeping unrelated params", () => {
    const out = tuneOpusSdp(SDP_WITH_FMTP);
    const fmtp = out.split("\r\n").find((l) => l.startsWith("a=fmtp:111"));
    expect(fmtp).toContain("minptime=10");
    expect(fmtp).toContain("stereo=1");
    expect(fmtp).toContain("sprop-stereo=1");
    expect(fmtp).toContain("maxaveragebitrate=128000");
    expect(fmtp).toContain("useinbandfec=1");
    // Params must not be duplicated when the line already had one of them.
    expect(fmtp!.match(/useinbandfec/g)).toHaveLength(1);
  });

  it("inserts an fmtp line when opus has none", () => {
    const sdp = SDP_WITH_FMTP.split("\r\n")
      .filter((l) => !l.startsWith("a=fmtp:111"))
      .join("\r\n");
    const lines = tuneOpusSdp(sdp).split("\r\n");
    const rtpmapIdx = lines.findIndex((l) => l.startsWith("a=rtpmap:111"));
    expect(lines[rtpmapIdx + 1]).toMatch(/^a=fmtp:111 .*stereo=1/);
  });

  it("does not touch non-opus payloads or opus-free SDP", () => {
    const out = tuneOpusSdp(SDP_WITH_FMTP);
    expect(out).toContain("a=rtpmap:63 red/48000/2");
    expect(out).not.toContain("a=fmtp:63");
    expect(out).not.toContain("a=fmtp:96");

    const noOpus = "m=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 VP8/90000";
    expect(tuneOpusSdp(noOpus)).toBe(noOpus);
  });

  it("is idempotent", () => {
    const once = tuneOpusSdp(SDP_WITH_FMTP);
    expect(tuneOpusSdp(once)).toBe(once);
  });
});
